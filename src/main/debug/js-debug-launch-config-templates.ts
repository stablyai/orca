import type { DebugAdapterConfig } from '../../shared/debug-session-types'

/**
 * Default `DebugAdapterConfig`s for the three vscode-js-debug scenarios v1
 * supports (see debug-prd.md's scope decision: parse VS Code's launch.json
 * shape for familiarity, but only the fields the bundled adapters actually
 * need — not full VS Code parity). `command`/`args` are unused by
 * `LocalJsDebugAdapterProcessHost`/`SshJsDebugAdapterProcessHost` (they
 * spawn the vendored `dapDebugServer.js` bundle themselves) and are set to
 * an informational placeholder only; the real per-scenario configuration
 * lives in `adapterArgs`, sent verbatim as the DAP `launch`/`attach` request.
 *
 * Workstream 3 (feat/debug-launch-config-templates, `.vscode/launch.json`
 * read/write) is expected to map parsed launch.json entries onto these same
 * `adapterArgs` shapes rather than reinvent them.
 */

export type NodeLaunchScriptOptions = {
  /** Absolute path to the script to run. */
  program: string
  cwd?: string
  args?: string[]
  env?: Record<string, string>
  stopOnEntry?: boolean
  /** e.g. a display name for the session; defaults to the program's basename. */
  name?: string
}

export function createNodeLaunchScriptConfig(options: NodeLaunchScriptOptions): DebugAdapterConfig {
  return {
    type: 'node',
    request: 'launch',
    command: 'vscode-js-debug:dapDebugServer',
    args: [],
    cwd: options.cwd,
    env: options.env,
    adapterArgs: {
      type: 'pwa-node',
      request: 'launch',
      name: options.name ?? options.program,
      program: options.program,
      cwd: options.cwd,
      args: options.args ?? [],
      env: options.env ?? {},
      console: 'internalConsole',
      stopOnEntry: options.stopOnEntry ?? false
    }
  }
}

export type NodeAttachOptions = {
  /** Port the target was started with (e.g. `node --inspect=9229 app.js`). */
  port?: number
  address?: string
  cwd?: string
  name?: string
}

export function createNodeAttachConfig(options: NodeAttachOptions = {}): DebugAdapterConfig {
  return {
    type: 'node',
    request: 'attach',
    command: 'vscode-js-debug:dapDebugServer',
    args: [],
    cwd: options.cwd,
    adapterArgs: {
      type: 'pwa-node',
      request: 'attach',
      name: options.name ?? 'Attach to Node process',
      port: options.port ?? 9229,
      address: options.address ?? 'localhost',
      cwd: options.cwd,
      // Why: reattaching to a process that's already running past its
      // entry point should never implicitly pause it.
      continueOnAttach: true
    }
  }
}

export type ChromeLaunchUrlOptions = {
  url: string
  /** Local directory the served URL maps back to, for source-mapped breakpoints in served (non-file) sources. */
  webRoot?: string
  name?: string
}

export function createChromeLaunchUrlConfig(options: ChromeLaunchUrlOptions): DebugAdapterConfig {
  return {
    type: 'chrome',
    request: 'launch',
    command: 'vscode-js-debug:dapDebugServer',
    args: [],
    adapterArgs: {
      type: 'pwa-chrome',
      request: 'launch',
      name: options.name ?? options.url,
      url: options.url,
      webRoot: options.webRoot
    }
  }
}
