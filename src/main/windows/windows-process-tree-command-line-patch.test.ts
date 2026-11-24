import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
