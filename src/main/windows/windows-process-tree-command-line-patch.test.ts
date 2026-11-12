import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** Assert the patch post-image so refreshes cannot restore table-wide VM_READ/ReadProcessMemory, which MDE flagged as credential dumping. */
const PATCH_PATH = resolve(
  import.meta.dirname,
  '../../../config/patches/@vscode__windows-process-tree@0.8.0.patch'
)

/** Reconstruct a file as the patch leaves it: context plus added lines. */
function patchedFile(patch: string, path: string): string {
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`diff --git a/${path} `))
  if (start === -1) {
    throw new Error(`${path} is not in the patch`)
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('diff --git '))
  return (
    (end === -1 ? rest : rest.slice(0, end))
      // Unified diffs may represent empty context lines as a bare space or empty string.
      .filter((line) => line === '' || line.startsWith(' ') || line.startsWith('+'))
      .filter((line) => !line.startsWith('+++') && !line.startsWith('@@'))
      .map((line) => line.slice(1))
      .join('\n')
  )
}

const patch = readFileSync(PATCH_PATH, 'utf8')
const commandLineSource = patchedFile(patch, 'src/process_commandline.cc')
const processSource = patchedFile(patch, 'src/process.cc')

describe('windows-process-tree command line patch', () => {
  it('reads the command line through ProcessCommandLineInformation', () => {
    // Class60 exists since Windows8.1, below Electron's Windows10 floor.
    expect(commandLineSource).toContain('kProcessCommandLineInformation = 60')
    expect(commandLineSource).toContain('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION')
  })

  it('resolves NtQueryInformationProcess dynamically rather than linking it', () => {
    expect(commandLineSource).toContain('GetModuleHandleW(L"ntdll.dll")')
    expect(commandLineSource).toContain('GetProcAddress(ntdll, "NtQueryInformationProcess")')
  })

  it('probes the buffer size before allocating, and caps it', () => {
    // STATUS_INFO_LENGTH_MISMATCH / STATUS_BUFFER_TOO_SMALL carry the size.
    expect(commandLineSource).toContain(
      'kStatusInfoLengthMismatch = static_cast<NTSTATUS>(0xC0000004L)'
    )
    expect(commandLineSource).toContain(
      'kStatusBufferTooSmall = static_cast<NTSTATUS>(0xC0000023L)'
    )
    expect(commandLineSource).toMatch(
      /query\(process, kProcessCommandLineInformation, nullptr, 0, &size\)/
    )
    // Reject oversized USHORT lengths before allocation can fail the entire scan.
    expect(commandLineSource).toContain('size > kMaxCommandLineBytes')
  })

  it('treats the returned UNICODE_STRING as untrusted', () => {
    // Bound returned strings against the original buffer, not the size overwritten by the second query.
    expect(commandLineSource).toContain('const unsigned char* end = begin + buffer.size()')
    expect(commandLineSource).toMatch(/chars == nullptr \|\|/)
    expect(commandLineSource).toMatch(/command_line->Length > static_cast<ULONG>\(end - chars\)/)
  })

  it('has no PEB fallback and no latch that could reinstate one', () => {
    // Any anomalous NTSTATUS previously restored PEB reads for the process lifetime.
    expect(commandLineSource).not.toContain('ReadCommandLineFromPeb')
    expect(commandLineSource).not.toContain('PROCESS_BASIC_INFORMATION')
    expect(commandLineSource).not.toContain('InterlockedExchange')
    expect(commandLineSource).not.toMatch(/ReadProcessMemory\(/)
  })

  it('acquires PROCESS_VM_READ nowhere in the addon', () => {
    for (const source of [commandLineSource, processSource]) {
      expect(source).not.toMatch(/OpenProcess\([^)]*PROCESS_VM_READ/)
      expect(source).not.toMatch(/ReadProcessMemory\(/)
    }
    // Memory/CPU counters plus creation time now use limited handles; none need VM_READ.
    expect(processSource.match(/OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION/g)).toHaveLength(3)
  })

  it('value-initializes ProcessInfo so memory is not stack garbage', () => {
    expect(processSource).toContain('ProcessInfo pinfo{};')
  })
})

type Addon = {
  getProcessList: (
    callback: (rows: { pid: number; commandLine?: string }[] | undefined) => void,
    flags: number
  ) => void
}

const addonRequire = createRequire(import.meta.url)

function loadAddon(): Addon {
  const packageEntry = addonRequire.resolve('@vscode/windows-process-tree')
  return addonRequire(
    join(packageEntry, '..', '..', 'build', 'Release', 'windows_process_tree.node')
  ) as Addon
}

// Windows must load our binary: the unpatched prebuilt emits identical text and would pass if skipped.
describe.runIf(process.platform === 'win32')('windows-process-tree command line addon', () => {
  // Defer require so missing binaries do not prevent platform-independent patch assertions.
  let addon: Addon
  beforeAll(() => {
    addon = loadAddon()
  })
  const children: { kill: () => void }[] = []
  afterAll(() => {
    for (const child of children) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })

  const scan = async (): Promise<Map<number, string>> =>
    new Promise((resolveScan) => {
      addon.getProcessList((rows) => {
        resolveScan(new Map((rows ?? []).map((row) => [row.pid, row.commandLine ?? ''])))
      }, 2 /* ProcessDataFlag.CommandLine */)
    })

  it('was built from the patched source, not the published prebuild', () => {
    // Import inspection distinguishes patched binaries; successful require and matching output cannot.
    const packageEntry = addonRequire.resolve('@vscode/windows-process-tree')
    const binary = readFileSync(
      join(packageEntry, '..', '..', 'build', 'Release', 'windows_process_tree.node')
    )
    expect(binary.includes('ReadProcessMemory')).toBe(false)
  })

  it('recovers command lines byte-for-byte, quoting and trailing spaces included', async () => {
    const marker = `orca-cmdline-${Date.now()}`
    // Quotes and trailing whitespace are exactly what a re-quoting bug eats.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', `"${marker}"  `], {
      windowsHide: true,
      stdio: 'ignore'
    })
    children.push(child)
    await new Promise((r) => setTimeout(r, 400))

    const rows = await scan()
    const command = rows.get(child.pid!)
    expect(command).toBeDefined()
    expect(command).toContain(marker)
    expect(command!.endsWith('  "') || command!.endsWith('  ')).toBe(true)
  })

  it('reports the querying process and most of the table', async () => {
    const rows = await scan()
    expect(rows.has(process.pid)).toBe(true)
    const recovered = [...rows.values()].filter((command) => command.length > 0)
    // Protected and cross-session processes legitimately deny a handle; a
    // wholesale regression would show up as almost nothing recovered.
    expect(recovered.length).toBeGreaterThan(rows.size * 0.25)
  })
})
