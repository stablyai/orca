import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { debugAdapterApprovalKey, type DebugSettings } from '../../shared/debug-settings-types'
import { resolveExecutableCommand } from '../../shared/node-cli-command-resolution'
import { isPathInside, normalizeDebugPath } from './debug-breakpoint-store'
import { buildAdapterEnv, DAP_SOCKET_PLACEHOLDER } from './dap-transport'

export { DAP_SOCKET_PLACEHOLDER }

/** Stands in for a tcp adapter's port in keys and the trust prompt; the real one is read back at spawn. */
export const DAP_PORT_PLACEHOLDER = '<port>'

/** tcp only where a socket cannot be dialed (dlv on Windows): a loopback port is open to every local user. */
export type DapTransport = 'stdio' | 'socket' | 'tcp'

export type DapResolveOptions = {
  pathEnv?: string | null
  platform?: NodeJS.Platform
  homePath?: string
  /** Read for XDG_DATA_HOME only. */
  env?: NodeJS.ProcessEnv
  settings?: Partial<Pick<DebugSettings, 'debugPythonPath' | 'debugJsDebugServerPath'>>
  worktreePath?: string
  /** The launch configuration's `python` key. */
  pythonOverride?: string
  /** `xcrun --find <tool>` stdout, or null; injected by tests. */
  xcrunFind?: (tool: string) => Promise<string | null>
  /** The repo's approved adapter keys; only an approved debugpy interpreter is probed for debugpy. */
  approvedKeys?: readonly string[]
}

type DapCommand = { binaryPath: string; args: string[] }

export type DapAdapterRow = {
  /** Registry id; names the adapter in approval keys and settings. */
  id: string
  label: string
  /** Empty means config-only: reachable through a launch.json `type`, never by opening a file. */
  languages: readonly string[]
  configTypes: readonly string[]
  transport: DapTransport
  /** The `initialize` adapterID. */
  adapterId: string
  /** Canonical launch `type` sent on the wire, whatever alias the user's config spelled. */
  wireType: string
  /** Merged UNDER the user's launch keys. */
  launchDefaults: Readonly<Record<string, unknown>>
  /** setBreakpoints answers verified:false before binding, so unverified means pending. */
  breakpointsBindLazily: boolean
  /** The root connection is a coordinator; the debuggee lives in a startDebugging child. */
  usesChildSessions: boolean
  workspaceFolderKey?: string
  installHint: string
  /** Null when not installed. Args hold DAP_SOCKET_PLACEHOLDER (or DAP_PORT_PLACEHOLDER) for server rows. */
  buildCommand: (options: DapResolveOptions) => Promise<DapCommand | null>
}

function resolve(command: string, options: DapResolveOptions): string | null {
  return resolveExecutableCommand(command, {
    pathEnv: options.pathEnv,
    platform: options.platform,
    homePath: options.homePath
  })
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function expandHome(path: string, options: DapResolveOptions): string {
  return path.startsWith('~/') || path.startsWith('~\\')
    ? join(options.homePath ?? homedir(), path.slice(2))
    : path
}

/** Launch key, then setting, then the worktree's .venv, then python3 on PATH; an explicit choice never falls through. */
export function resolveDebugPython(options: DapResolveOptions): string | null {
  const explicit = options.pythonOverride || options.settings?.debugPythonPath
  if (explicit) {
    return resolve(explicit, options)
  }
  const platform = options.platform ?? process.platform
  if (options.worktreePath) {
    const venv =
      platform === 'win32'
        ? join(options.worktreePath, '.venv', 'Scripts', 'python.exe')
        : join(options.worktreePath, '.venv', 'bin', 'python')
    const found = resolve(venv, options)
    if (found) {
      return found
    }
  }
  // Why `python` first on Windows: python.org installs no python3.exe; that name is the Store stub.
  const names = platform === 'win32' ? ['python', 'python3'] : ['python3']
  for (const name of names) {
    const found = resolve(name, options)
    if (found) {
      return found
    }
  }
  return null
}

/** The setting, else $XDG_DATA_HOME (default ~/.local/share)/js-debug/src/dapDebugServer.js; a FILE, never downloaded. */
export function resolveJsDebugServerPath(options: DapResolveOptions): string | null {
  const configured = options.settings?.debugJsDebugServerPath
  if (configured) {
    const expanded = expandHome(configured, options)
    return isAbsolute(expanded) && isFile(expanded) ? expanded : null
  }
  const xdg = (options.env ?? process.env).XDG_DATA_HOME
  // XDG spec: a relative XDG_DATA_HOME is invalid and ignored.
  const dataHome =
    xdg && isAbsolute(xdg) ? xdg : join(options.homePath ?? homedir(), '.local', 'share')
  const server = join(dataHome, 'js-debug', 'src', 'dapDebugServer.js')
  return isFile(server) ? server : null
}

async function defaultXcrunFind(tool: string): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/usr/bin/xcrun',
      args: ['--find', tool],
      timeoutMs: 5000
    })
    return result.code === 0 && !result.timedOut ? result.stdout.trim() || null : null
  } catch {
    return null
  }
}

const DEBUGPY_HINT = 'Run `pip install debugpy` in the interpreter that runs this project.'

const JS_DEBUG_HINT =
  'Download js-debug-dap-<version>.tar.gz from https://github.com/microsoft/vscode-js-debug/releases ' +
  'and extract it into ~/.local/share (node is also required), or set the js-debug server path.'

export const DAP_ADAPTERS: readonly DapAdapterRow[] = [
  {
    id: 'debugpy',
    label: 'debugpy',
    languages: ['python'],
    configTypes: ['debugpy', 'python'],
    transport: 'stdio',
    adapterId: 'python',
    wireType: 'debugpy',
    // internalConsole: any other console hands the program the adapter's stdio, which is the protocol stream.
    launchDefaults: { justMyCode: false, console: 'internalConsole' },
    breakpointsBindLazily: false,
    usesChildSessions: false,
    installHint: DEBUGPY_HINT,
    buildCommand: async (options) => {
      const python = resolveDebugPython(options)
      return python ? { binaryPath: python, args: ['-m', 'debugpy.adapter'] } : null
    }
  },
  {
    id: 'lldb-dap',
    label: 'LLDB',
    languages: ['c', 'cpp', 'rust', 'swift'],
    configTypes: ['lldb-dap', 'lldb'],
    transport: 'stdio',
    adapterId: 'lldb-dap',
    wireType: 'lldb-dap',
    launchDefaults: {},
    breakpointsBindLazily: false,
    usesChildSessions: false,
    installHint:
      'Install the Xcode command line tools (`xcode-select --install`) on macOS, or LLVM’s lldb-dap elsewhere.',
    buildCommand: async (options) => {
      const onPath = resolve('lldb-dap', options)
      if (onPath) {
        return { binaryPath: onPath, args: [] }
      }
      if ((options.platform ?? process.platform) !== 'darwin') {
        return null
      }
      const printed = await (options.xcrunFind ?? defaultXcrunFind)('lldb-dap')
      // Re-checked so the trust prompt never names a path xcrun printed but that cannot run.
      const binaryPath = printed && isAbsolute(printed) ? resolve(printed, options) : null
      return binaryPath ? { binaryPath, args: [] } : null
    }
  },
  {
    id: 'dlv',
    label: 'Delve',
    languages: ['go'],
    configTypes: ['go'],
    transport: 'socket',
    adapterId: 'go',
    wireType: 'go',
    // Without remote, delve hands the debuggee the adapter's own stdio and program output is lost.
    launchDefaults: { outputMode: 'remote' },
    breakpointsBindLazily: false,
    usesChildSessions: false,
    installHint: 'Run `go install github.com/go-delve/delve/cmd/dlv@latest`.',
    buildCommand: async (options) => {
      const dlv = resolve('dlv', options)
      // Node dials a Windows path as a named pipe, never dlv's AF_UNIX socket.
      const listen =
        (options.platform ?? process.platform) === 'win32'
          ? `127.0.0.1:${DAP_PORT_PLACEHOLDER}`
          : `unix:${DAP_SOCKET_PLACEHOLDER}`
      return dlv ? { binaryPath: dlv, args: ['dap', '--listen', listen] } : null
    }
  },
  {
    id: 'js-debug',
    label: 'JavaScript Debugger',
    languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    configTypes: ['node', 'pwa-node'],
    transport: 'socket',
    adapterId: 'pwa-node',
    wireType: 'pwa-node',
    launchDefaults: {},
    breakpointsBindLazily: true,
    usesChildSessions: true,
    workspaceFolderKey: '__workspaceFolder',
    installHint: JS_DEBUG_HINT,
    buildCommand: async (options) => {
      const server = resolveJsDebugServerPath(options)
      const node = server ? resolve('node', options) : null
      // A non-numeric first argument makes dapDebugServer.js listen on that socket path.
      return server && node ? { binaryPath: node, args: [server, DAP_SOCKET_PLACEHOLDER] } : null
    }
  }
]

/** First row claiming the language; config-only rows never answer. */
export function adapterForLanguage(
  languageId: string,
  table: readonly DapAdapterRow[] = DAP_ADAPTERS
): DapAdapterRow | undefined {
  return table.find((row) => row.languages.includes(languageId))
}

export function adapterForConfigType(
  configType: string,
  table: readonly DapAdapterRow[] = DAP_ADAPTERS
): DapAdapterRow | undefined {
  return table.find((row) => row.configTypes.includes(configType))
}

export type ResolvedDebugAdapter =
  | {
      ok: true
      binaryPath: string
      /** What the key and trust prompt name; server rows carry a socket or port placeholder. */
      args: string[]
      /** What to spawn: a port placeholder becomes 0; the transport fills the socket path. */
      spawnArgs: string[]
      approvalKey: string
      transport: DapTransport
      /** The binary is in the worktree (or links from it), so anything that writes the repo can change it. */
      repoLocal: boolean
    }
  | { ok: false; reason: 'not-found'; hint: string }

/** The link itself counts: a .venv/bin/python symlink resolves outside, but the repo controls it. */
function isRepoLocal(binaryPath: string, worktreePath: string | undefined): boolean {
  const root = worktreePath && normalizeDebugPath(worktreePath)
  const link = join(normalizeDebugPath(dirname(binaryPath)), basename(binaryPath))
  return !!root && (isPathInside(root, link) || isPathInside(root, normalizeDebugPath(binaryPath)))
}

export async function resolveDebugAdapter(
  row: DapAdapterRow,
  options: DapResolveOptions = {}
): Promise<ResolvedDebugAdapter> {
  const command = await row.buildCommand(options)
  if (!command) {
    return { ok: false, reason: 'not-found', hint: row.installHint }
  }
  const { binaryPath, args } = command
  const approvalKey = debugAdapterApprovalKey(row.id, binaryPath, args)
  if (row.id === 'debugpy' && options.approvedKeys?.includes(approvalKey)) {
    const probe = await probeDebugpy(binaryPath, {
      approvalKey,
      approvedKeys: options.approvedKeys
    })
    if (!probe.ok) {
      return { ok: false, reason: 'not-found', hint: probe.hint }
    }
  }
  const has = (placeholder: string) => args.some((arg) => arg.includes(placeholder))
  return {
    ok: true,
    binaryPath,
    args,
    spawnArgs: args.map((arg) => arg.replaceAll(DAP_PORT_PLACEHOLDER, '0')),
    approvalKey,
    transport: has(DAP_SOCKET_PLACEHOLDER) ? 'socket' : has(DAP_PORT_PLACEHOLDER) ? 'tcp' : 'stdio',
    repoLocal: isRepoLocal(binaryPath, options.worktreePath)
  }
}

/** The trust prompt shows binaryPath + args; approving stores exactly `approvalKey`. */
export async function describeDebugAdapters(
  options: DapResolveOptions = {},
  table: readonly DapAdapterRow[] = DAP_ADAPTERS
) {
  // Config-only rows share a binary with a language row; listing both would report one install twice.
  const rows = table.filter((row) => row.languages.length > 0)
  return Promise.all(
    rows.map(async (row) => {
      const resolved = await resolveDebugAdapter(row, options)
      return {
        adapterId: row.id,
        label: row.label,
        languages: [...row.languages],
        transport: resolved.ok ? resolved.transport : row.transport,
        binaryPath: resolved.ok ? resolved.binaryPath : null,
        args: resolved.ok ? resolved.args : null,
        approvalKey: resolved.ok ? resolved.approvalKey : null,
        repoLocal: resolved.ok && resolved.repoLocal,
        hint: resolved.ok ? null : resolved.hint
      }
    })
  )
}

const DEBUGPY_PROBE_TIMEOUT_MS = 5000

/**
 * Whether `python` can import debugpy. It runs the interpreter, which may be the worktree's own
 * .venv, so it refuses unless that exact key is approved; -E, the adapter env allowlist and a cwd
 * outside the worktree keep main's secrets and the repo's root modules out of it.
 */
export async function probeDebugpy(
  python: string,
  approval: { approvalKey: string; approvedKeys: readonly string[] }
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'not-approved'; hint: string }> {
  if (!approval.approvedKeys.includes(approval.approvalKey)) {
    return { ok: false, reason: 'not-approved', hint: `${python} is not approved to run.` }
  }
  const notFound = { ok: false, reason: 'not-found', hint: DEBUGPY_HINT } as const
  try {
    const result = await runProcess({
      program: python,
      args: ['-E', '-c', 'import debugpy'],
      cwd: homedir(),
      env: buildAdapterEnv(),
      timeoutMs: DEBUGPY_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    return result.code === 0 && !result.timedOut ? { ok: true } : notFound
  } catch {
    return notFound
  }
}
