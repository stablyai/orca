#!/usr/bin/env node
/* eslint-disable max-lines -- Why: the public CLI entrypoint keeps command dispatch in one place so the bundled shell command and development fallback stay behaviorally identical. */

import { isAbsolute, relative, resolve as resolvePath } from 'path'
import type {
  CliStatusResult,
  RuntimeRepoList,
  RuntimeRepoSearchRefs,
  RuntimeWorktreeRecord,
  RuntimeWorktreePsResult,
  RuntimeWorktreeListResult,
  RuntimeTerminalRead,
  RuntimeTerminalListResult,
  RuntimeTerminalShow,
  RuntimeTerminalSend,
  RuntimeTerminalWait,
  RuntimeTerminalCreate,
  RuntimeTerminalSplit,
  RuntimeTerminalRename,
  RuntimeTerminalFocus,
  RuntimeTerminalClose,
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult,
  BrowserTypeResult,
  BrowserSelectResult,
  BrowserScrollResult,
  BrowserBackResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserEvalResult,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserHoverResult,
  BrowserDragResult,
  BrowserUploadResult,
  BrowserWaitResult,
  BrowserCheckResult,
  BrowserFocusResult,
  BrowserClearResult,
  BrowserSelectAllResult,
  BrowserKeypressResult,
  BrowserPdfResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserCookieDeleteResult,
  BrowserViewportResult,
  BrowserGeolocationResult,
  BrowserInterceptEnableResult,
  BrowserInterceptDisableResult,
  BrowserInterceptedRequest,
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleResult,
  BrowserNetworkLogResult
} from '../shared/runtime-types'
import {
  RuntimeClient,
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from './runtime-client'
import type { RuntimeRpcFailure } from './runtime-client'

type ParsedArgs = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

type CommandSpec = {
  path: string[]
  summary: string
  usage: string
  allowedFlags: string[]
  examples?: string[]
  notes?: string[]
}

type BrowserCliTarget = {
  worktree?: string
  page?: string
}

const DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS = 60_000
const GLOBAL_FLAGS = ['help', 'json']
export const COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['open'],
    summary: 'Launch Orca and wait for the runtime to be reachable',
    usage: 'orca open [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca open', 'orca open --json']
  },
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'orca status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca status', 'orca status --json']
  },
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Orca',
    usage: 'orca repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Orca by filesystem path',
    usage: 'orca repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'orca repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'orca repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['worktree', 'list'],
    summary: 'List Orca-managed worktrees',
    usage: 'orca worktree list [--repo <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'limit']
  },
  {
    path: ['worktree', 'show'],
    summary: 'Show one worktree',
    usage: 'orca worktree show --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['worktree', 'current'],
    summary: 'Show the Orca-managed worktree for the current directory',
    usage: 'orca worktree current [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Resolves the current shell directory to a path: selector so agents can target the enclosing Orca worktree without spelling out $PWD.'
    ],
    examples: ['orca worktree current', 'orca worktree current --json']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a new Orca-managed worktree',
    usage:
      'orca worktree create --repo <selector> --name <name> [--base-branch <ref>] [--issue <number>] [--comment <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'name', 'base-branch', 'issue', 'comment'],
    notes: ['By default this matches the Orca UI flow and activates the new worktree in the app.']
  },
  {
    path: ['worktree', 'set'],
    summary: 'Update Orca metadata for a worktree',
    usage:
      'orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--comment <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'display-name', 'issue', 'comment']
  },
  {
    path: ['worktree', 'rm'],
    summary: 'Remove a worktree from Orca and git',
    usage: 'orca worktree rm --worktree <selector> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force']
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'orca worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['terminal', 'list'],
    summary: 'List live Orca-managed terminals',
    usage: 'orca terminal list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'orca terminal show [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage: 'orca terminal read [--terminal <handle>] [--cursor <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'cursor'],
    notes: [
      'Omit --terminal to target the active terminal in the current worktree.',
      'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
      'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
    ],
    examples: [
      'orca terminal read --json',
      'orca terminal read --terminal term_abc123 --cursor 42 --json'
    ]
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'text', 'enter', 'interrupt']
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage:
      'orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree',
    usage: 'orca terminal stop --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['terminal', 'create'],
    summary: 'Create a new terminal tab in the current worktree',
    usage:
      'orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'command', 'title'],
    examples: [
      'orca terminal create --json',
      'orca terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"'
    ]
  },
  {
    path: ['terminal', 'switch'],
    summary: 'Switch to a terminal tab in the UI',
    usage: 'orca terminal switch [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['orca terminal switch --terminal term_abc123']
  },
  {
    path: ['terminal', 'focus'],
    summary: 'Switch to a terminal tab in the UI (alias for terminal switch)',
    usage: 'orca terminal focus [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['orca terminal focus --terminal term_abc123']
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal tab (kills PTY if running)',
    usage: 'orca terminal close [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['orca terminal close --terminal term_abc123']
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Set or clear the title of a terminal tab',
    usage: 'orca terminal rename [--terminal <handle>] [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
    notes: ['Omit --title or pass an empty string to reset to the auto-generated title.'],
    examples: [
      'orca terminal rename --terminal term_abc123 --title "RUNNER"',
      'orca terminal rename --terminal term_abc123 --json'
    ]
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split an existing terminal pane',
    usage:
      'orca terminal split [--terminal <handle>] [--direction horizontal|vertical] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'direction', 'command'],
    examples: [
      'orca terminal split --terminal term_abc123 --direction horizontal --json',
      'orca terminal split --terminal term_abc123 --command "codex"'
    ]
  },
  // ── Browser automation ──
  {
    path: ['snapshot'],
    summary: 'Capture an accessibility snapshot of the active browser tab',
    usage: 'orca snapshot [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['screenshot'],
    summary: 'Capture a viewport screenshot of the active browser tab',
    usage: 'orca screenshot [--format <png|jpeg>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format', 'worktree']
  },
  {
    path: ['click'],
    summary: 'Click a browser element by ref',
    usage: 'orca click --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['fill'],
    summary: 'Clear and fill a browser input by ref',
    usage: 'orca fill --element <ref> --value <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value', 'worktree']
  },
  {
    path: ['type'],
    summary: 'Type text at the current browser focus',
    usage: 'orca type --input <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input', 'worktree']
  },
  {
    path: ['select'],
    summary: 'Select a dropdown option by ref',
    usage: 'orca select --element <ref> --value <value> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value', 'worktree']
  },
  {
    path: ['scroll'],
    summary: 'Scroll the browser viewport',
    usage: 'orca scroll --direction <up|down> [--amount <pixels>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'direction', 'amount', 'worktree']
  },
  {
    path: ['goto'],
    summary: 'Navigate the active browser tab to a URL',
    usage: 'orca goto --url <url> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url', 'worktree']
  },
  {
    path: ['back'],
    summary: 'Navigate back in browser history',
    usage: 'orca back [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['reload'],
    summary: 'Reload the active browser tab',
    usage: 'orca reload [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['eval'],
    summary: 'Evaluate JavaScript in the browser page context',
    usage: 'orca eval --expression <js> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'expression', 'worktree']
  },
  {
    path: ['wait'],
    summary: 'Wait for element, text, URL, load state, JS condition, or timeout',
    usage:
      'orca wait [--selector <sel>] [--timeout <ms>] [--text <text>] [--url <pattern>] [--load <state>] [--fn <js>] [--state <hidden|visible>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'selector',
      'timeout',
      'text',
      'url',
      'load',
      'fn',
      'state',
      'worktree'
    ]
  },
  {
    path: ['check'],
    summary: 'Check a checkbox/radio by ref',
    usage: 'orca check --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['uncheck'],
    summary: 'Uncheck a checkbox/radio by ref',
    usage: 'orca uncheck --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['focus'],
    summary: 'Focus a browser element by ref',
    usage: 'orca focus --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['clear'],
    summary: 'Clear an input element by ref',
    usage: 'orca clear --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['select-all'],
    summary: 'Select all text in an input by ref',
    usage: 'orca select-all --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['keypress'],
    summary: 'Press a key (Enter, Tab, Escape, ArrowDown, etc.)',
    usage: 'orca keypress --key <name> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'worktree']
  },
  {
    path: ['pdf'],
    summary: 'Export the active browser tab as PDF',
    usage: 'orca pdf [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['full-screenshot'],
    summary: 'Capture a full-page screenshot (beyond viewport)',
    usage: 'orca full-screenshot [--format <png|jpeg>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format', 'worktree']
  },
  {
    path: ['hover'],
    summary: 'Hover over a browser element by ref',
    usage: 'orca hover --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['drag'],
    summary: 'Drag from one element to another',
    usage: 'orca drag --from <ref> --to <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from', 'to', 'worktree']
  },
  {
    path: ['upload'],
    summary: 'Upload files to a file input element',
    usage: 'orca upload --element <ref> --files <path,...> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'files', 'worktree']
  },
  {
    path: ['tab', 'list'],
    summary: 'List open browser tabs',
    usage: 'orca tab list [--worktree <selector|all>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['tab', 'switch'],
    summary: 'Switch the active browser tab',
    usage: 'orca tab switch (--index <n> | --page <id>) [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'index', 'worktree']
  },
  {
    path: ['tab', 'create'],
    summary: 'Create a new browser tab in the current worktree',
    usage: 'orca tab create [--url <url>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url', 'worktree']
  },
  {
    path: ['tab', 'close'],
    summary: 'Close a browser tab',
    usage: 'orca tab close [--index <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'index', 'worktree']
  },
  {
    path: ['exec'],
    summary: 'Run any agent-browser command against the active browser tab',
    usage: 'orca exec --command "<agent-browser command>" [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'command', 'worktree']
  },
  // ── Cookie management ──
  {
    path: ['cookie', 'get'],
    summary: 'Get cookies for the active tab (optionally filter by URL)',
    usage: 'orca cookie get [--url <url>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url', 'worktree']
  },
  {
    path: ['cookie', 'set'],
    summary: 'Set a cookie',
    usage:
      'orca cookie set --name <n> --value <v> [--domain <d>] [--path <p>] [--secure] [--httpOnly] [--sameSite <s>] [--expires <epoch>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'value',
      'domain',
      'path',
      'secure',
      'httpOnly',
      'sameSite',
      'expires',
      'worktree'
    ]
  },
  {
    path: ['cookie', 'delete'],
    summary: 'Delete a cookie by name',
    usage:
      'orca cookie delete --name <n> [--domain <d>] [--url <u>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'domain', 'url', 'worktree']
  },
  // ── Viewport ──
  {
    path: ['viewport'],
    summary: 'Set browser viewport size',
    usage:
      'orca viewport --width <w> --height <h> [--scale <n>] [--mobile] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'width', 'height', 'scale', 'mobile', 'worktree']
  },
  // ── Geolocation ──
  {
    path: ['geolocation'],
    summary: 'Override browser geolocation',
    usage:
      'orca geolocation --latitude <lat> --longitude <lon> [--accuracy <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'latitude', 'longitude', 'accuracy', 'worktree']
  },
  // ── Request interception ──
  {
    path: ['intercept', 'enable'],
    summary: 'Enable request interception (pause matching requests)',
    usage: 'orca intercept enable [--patterns <glob,...>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'patterns', 'worktree']
  },
  {
    path: ['intercept', 'disable'],
    summary: 'Disable request interception',
    usage: 'orca intercept disable [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['intercept', 'list'],
    summary: 'List paused (intercepted) requests',
    usage: 'orca intercept list [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  // TODO: add intercept continue/block once agent-browser supports per-request
  // interception decisions (currently only supports URL-pattern-based route/unroute).
  // ── Console/network capture ──
  {
    path: ['capture', 'start'],
    summary: 'Start capturing console and network events',
    usage: 'orca capture start [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['capture', 'stop'],
    summary: 'Stop capturing console and network events',
    usage: 'orca capture stop [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['console'],
    summary: 'Show captured console log entries',
    usage: 'orca console [--limit <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'worktree']
  },
  {
    path: ['network'],
    summary: 'Show captured network requests',
    usage: 'orca network [--limit <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'worktree']
  },
  // ── Additional core commands ──
  {
    path: ['dblclick'],
    summary: 'Double-click element by ref',
    usage: 'orca dblclick --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['forward'],
    summary: 'Navigate forward in browser history',
    usage: 'orca forward [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['scrollintoview'],
    summary: 'Scroll element into view',
    usage: 'orca scrollintoview --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['get'],
    summary: 'Get element property (text, html, value, url, title, count, box)',
    usage: 'orca get --what <property> [--element <ref>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'what', 'element', 'worktree']
  },
  {
    path: ['is'],
    summary: 'Check element state (visible, enabled, checked)',
    usage: 'orca is --what <state> --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'what', 'element', 'worktree']
  },
  // ── Keyboard insert text ──
  {
    path: ['inserttext'],
    summary: 'Insert text without key events',
    usage: 'orca inserttext --text <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'worktree']
  },
  // ── Mouse commands ──
  {
    path: ['mouse', 'move'],
    summary: 'Move mouse to x,y coordinates',
    usage: 'orca mouse move --x <n> --y <n> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'x', 'y', 'worktree']
  },
  {
    path: ['mouse', 'down'],
    summary: 'Press mouse button',
    usage: 'orca mouse down [--button <left|right|middle>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'button', 'worktree']
  },
  {
    path: ['mouse', 'up'],
    summary: 'Release mouse button',
    usage: 'orca mouse up [--button <left|right|middle>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'button', 'worktree']
  },
  {
    path: ['mouse', 'wheel'],
    summary: 'Scroll wheel',
    usage: 'orca mouse wheel --dy <n> [--dx <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dy', 'dx', 'worktree']
  },
  // ── Find (semantic locators) ──
  {
    path: ['find'],
    summary: 'Find element by semantic locator and perform action',
    usage:
      'orca find --locator <type> --value <text> --action <action> [--text <text>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'locator', 'value', 'action', 'text', 'worktree']
  },
  // ── Set commands ──
  {
    path: ['set', 'device'],
    summary: 'Emulate a device',
    usage: 'orca set device --name <device> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'worktree']
  },
  {
    path: ['set', 'offline'],
    summary: 'Toggle offline mode',
    usage: 'orca set offline [--state <on|off>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'state', 'worktree']
  },
  {
    path: ['set', 'headers'],
    summary: 'Set extra HTTP headers',
    usage: 'orca set headers --headers <json> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'headers', 'worktree']
  },
  {
    path: ['set', 'credentials'],
    summary: 'Set HTTP auth credentials',
    usage: 'orca set credentials --user <user> --pass <pass> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'user', 'pass', 'worktree']
  },
  {
    path: ['set', 'media'],
    summary: 'Set color scheme and reduced motion preferences',
    usage:
      'orca set media [--color-scheme <dark|light>] [--reduced-motion <reduce|no-preference>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'color-scheme', 'reduced-motion', 'worktree']
  },
  // ── Clipboard commands ──
  {
    path: ['clipboard', 'read'],
    summary: 'Read clipboard contents',
    usage: 'orca clipboard read [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['clipboard', 'write'],
    summary: 'Write text to clipboard',
    usage: 'orca clipboard write --text <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'worktree']
  },
  // ── Dialog commands ──
  {
    path: ['dialog', 'accept'],
    summary: 'Accept a browser dialog',
    usage: 'orca dialog accept [--text <text>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'worktree']
  },
  {
    path: ['dialog', 'dismiss'],
    summary: 'Dismiss a browser dialog',
    usage: 'orca dialog dismiss [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  // ── Storage commands ──
  {
    path: ['storage', 'local', 'get'],
    summary: 'Get a localStorage value by key',
    usage: 'orca storage local get --key <key> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'worktree']
  },
  {
    path: ['storage', 'local', 'set'],
    summary: 'Set a localStorage value',
    usage: 'orca storage local set --key <key> --value <value> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'value', 'worktree']
  },
  {
    path: ['storage', 'local', 'clear'],
    summary: 'Clear all localStorage',
    usage: 'orca storage local clear [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['storage', 'session', 'get'],
    summary: 'Get a sessionStorage value by key',
    usage: 'orca storage session get --key <key> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'worktree']
  },
  {
    path: ['storage', 'session', 'set'],
    summary: 'Set a sessionStorage value',
    usage: 'orca storage session set --key <key> --value <value> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'value', 'worktree']
  },
  {
    path: ['storage', 'session', 'clear'],
    summary: 'Clear all sessionStorage',
    usage: 'orca storage session clear [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  // ── Download command ──
  {
    path: ['download'],
    summary: 'Download a file by clicking a selector',
    usage: 'orca download --selector <ref> --path <path> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'selector', 'path', 'worktree']
  },
  // ── Highlight command ──
  {
    path: ['highlight'],
    summary: 'Highlight an element by selector',
    usage: 'orca highlight --selector <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'selector', 'worktree']
  }
]

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(argv)
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null) {
    printHelp(helpPath)
    if (helpPath.length > 0 && !findCommandSpec(helpPath) && !isCommandGroup(helpPath)) {
      process.exitCode = 1
    }
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp([])
    return
  }
  const json = parsed.flags.has('json')

  try {
    // Why: CLI syntax and flag errors should be reported before any runtime
    // lookup so users do not get misleading "Orca is not running" failures for
    // simple command typos or unsupported flags.
    validateCommandAndFlags(parsed)

    const client = new RuntimeClient()
    const { commandPath } = parsed

    if (matches(commandPath, ['open'])) {
      const result = await client.openOrca()
      return printResult(result, json, formatCliStatus)
    }

    if (matches(commandPath, ['status'])) {
      const result = await client.getCliStatus()
      if (!json && !result.result.runtime.reachable) {
        process.exitCode = 1
      }
      return printResult(result, json, formatStatus)
    }

    if (matches(commandPath, ['repo', 'list'])) {
      const result = await client.call<RuntimeRepoList>('repo.list')
      return printResult(result, json, formatRepoList)
    }

    if (matches(commandPath, ['repo', 'add'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
        path: getRequiredStringFlag(parsed.flags, 'path')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'show'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
        repo: getRequiredStringFlag(parsed.flags, 'repo')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'set-base-ref'])) {
      const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        ref: getRequiredStringFlag(parsed.flags, 'ref')
      })
      return printResult(result, json, formatRepoShow)
    }

    if (matches(commandPath, ['repo', 'search-refs'])) {
      const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        query: getRequiredStringFlag(parsed.flags, 'query'),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatRepoRefs)
    }

    if (matches(commandPath, ['terminal', 'list'])) {
      const result = await client.call<RuntimeTerminalListResult>('terminal.list', {
        worktree: await getOptionalWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatTerminalList)
    }

    if (matches(commandPath, ['terminal', 'show'])) {
      const result = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client)
      })
      return printResult(result, json, formatTerminalShow)
    }

    if (matches(commandPath, ['terminal', 'read'])) {
      const cursorFlag = getOptionalStringFlag(parsed.flags, 'cursor')
      const cursor =
        cursorFlag !== undefined && /^\d+$/.test(cursorFlag)
          ? Number.parseInt(cursorFlag, 10)
          : undefined
      if (cursorFlag !== undefined && cursor === undefined) {
        throw new RuntimeClientError('invalid_argument', '--cursor must be a non-negative integer')
      }
      const result = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client),
        ...(cursor !== undefined ? { cursor } : {})
      })
      return printResult(result, json, formatTerminalRead)
    }

    if (matches(commandPath, ['terminal', 'send'])) {
      const result = await client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client),
        text: getOptionalStringFlag(parsed.flags, 'text'),
        enter: parsed.flags.get('enter') === true,
        interrupt: parsed.flags.get('interrupt') === true
      })
      return printResult(result, json, formatTerminalSend)
    }

    if (matches(commandPath, ['terminal', 'wait'])) {
      const timeoutMs = getOptionalPositiveIntegerFlag(parsed.flags, 'timeout-ms')
      const result = await client.call<{ wait: RuntimeTerminalWait }>(
        'terminal.wait',
        {
          terminal: await getTerminalHandle(parsed.flags, cwd, client),
          for: getRequiredStringFlag(parsed.flags, 'for'),
          timeoutMs
        },
        {
          // Why: terminal wait legitimately needs to outlive the CLI's default
          // RPC timeout. Even without an explicit server timeout, the client must
          // allow long waits instead of failing at the generic 15s transport cap.
          timeoutMs: timeoutMs ? timeoutMs + 5000 : DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS
        }
      )
      return printResult(result, json, formatTerminalWait)
    }

    if (matches(commandPath, ['terminal', 'stop'])) {
      const result = await client.call<{ stopped: number }>('terminal.stop', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client)
      })
      return printResult(result, json, (value) => `Stopped ${value.stopped} terminals.`)
    }

    if (matches(commandPath, ['terminal', 'rename'])) {
      const result = await client.call<{ rename: RuntimeTerminalRename }>('terminal.rename', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client),
        title: getOptionalStringFlag(parsed.flags, 'title') ?? null
      })
      return printResult(result, json, formatTerminalRename)
    }

    if (matches(commandPath, ['terminal', 'create'])) {
      const result = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
        worktree: await getBrowserWorktreeSelector(parsed.flags, cwd, client),
        command: getOptionalStringFlag(parsed.flags, 'command'),
        title: getOptionalStringFlag(parsed.flags, 'title')
      })
      return printResult(result, json, formatTerminalCreate)
    }

    if (
      matches(commandPath, ['terminal', 'focus']) ||
      matches(commandPath, ['terminal', 'switch'])
    ) {
      const result = await client.call<{ focus: RuntimeTerminalFocus }>('terminal.focus', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client)
      })
      return printResult(result, json, formatTerminalFocus)
    }

    if (matches(commandPath, ['terminal', 'close'])) {
      const result = await client.call<{ close: RuntimeTerminalClose }>('terminal.close', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client)
      })
      return printResult(result, json, formatTerminalClose)
    }

    if (matches(commandPath, ['terminal', 'split'])) {
      const directionFlag = getOptionalStringFlag(parsed.flags, 'direction')
      if (
        directionFlag !== undefined &&
        directionFlag !== 'horizontal' &&
        directionFlag !== 'vertical'
      ) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--direction must be horizontal or vertical'
        )
      }
      const result = await client.call<{ split: RuntimeTerminalSplit }>('terminal.split', {
        terminal: await getTerminalHandle(parsed.flags, cwd, client),
        direction: directionFlag,
        command: getOptionalStringFlag(parsed.flags, 'command')
      })
      return printResult(result, json, formatTerminalSplit)
    }

    if (matches(commandPath, ['worktree', 'ps'])) {
      const result = await client.call<RuntimeWorktreePsResult>('worktree.ps', {
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatWorktreePs)
    }

    if (matches(commandPath, ['worktree', 'list'])) {
      const result = await client.call<RuntimeWorktreeListResult>('worktree.list', {
        repo: getOptionalStringFlag(parsed.flags, 'repo'),
        limit: getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      })
      return printResult(result, json, formatWorktreeList)
    }

    if (matches(commandPath, ['worktree', 'show'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client)
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'current'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: await resolveCurrentWorktreeSelector(cwd, client)
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'create'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.create', {
        repo: getRequiredStringFlag(parsed.flags, 'repo'),
        name: getRequiredStringFlag(parsed.flags, 'name'),
        baseBranch: getOptionalStringFlag(parsed.flags, 'base-branch'),
        linkedIssue: getOptionalNumberFlag(parsed.flags, 'issue'),
        comment: getOptionalStringFlag(parsed.flags, 'comment')
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'set'])) {
      const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        displayName: getOptionalStringFlag(parsed.flags, 'display-name'),
        linkedIssue: getOptionalNullableNumberFlag(parsed.flags, 'issue'),
        comment: getOptionalStringFlag(parsed.flags, 'comment')
      })
      return printResult(result, json, formatWorktreeShow)
    }

    if (matches(commandPath, ['worktree', 'rm'])) {
      const result = await client.call<{ removed: boolean }>('worktree.rm', {
        worktree: await getRequiredWorktreeSelector(parsed.flags, 'worktree', cwd, client),
        force: parsed.flags.get('force') === true
      })
      return printResult(result, json, (value) => `removed: ${value.removed}`)
    }

    // ── Browser automation dispatch ──

    if (matches(commandPath, ['snapshot'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserSnapshotResult>('browser.snapshot', target)
      return printResult(result, json, formatSnapshot)
    }

    if (matches(commandPath, ['screenshot'])) {
      const format = getOptionalStringFlag(parsed.flags, 'format')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserScreenshotResult>('browser.screenshot', {
        format: format === 'jpeg' ? 'jpeg' : undefined,
        ...target
      })
      return printResult(result, json, formatScreenshot)
    }

    if (matches(commandPath, ['click'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserClickResult>('browser.click', { element, ...target })
      return printResult(result, json, (v) => `Clicked ${v.clicked}`)
    }

    if (matches(commandPath, ['fill'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserFillResult>('browser.fill', {
        element,
        value,
        ...target
      })
      return printResult(result, json, (v) => `Filled ${v.filled}`)
    }

    if (matches(commandPath, ['type'])) {
      const input = getRequiredStringFlag(parsed.flags, 'input')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserTypeResult>('browser.type', { input, ...target })
      return printResult(result, json, () => 'Typed input')
    }

    if (matches(commandPath, ['select'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserSelectResult>('browser.select', {
        element,
        value,
        ...target
      })
      return printResult(result, json, (v) => `Selected ${v.selected}`)
    }

    if (matches(commandPath, ['scroll'])) {
      const direction = getRequiredStringFlag(parsed.flags, 'direction')
      if (direction !== 'up' && direction !== 'down') {
        throw new RuntimeClientError('invalid_argument', '--direction must be "up" or "down"')
      }
      const amount = getOptionalPositiveIntegerFlag(parsed.flags, 'amount')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserScrollResult>('browser.scroll', {
        direction,
        amount,
        ...target
      })
      return printResult(result, json, (v) => `Scrolled ${v.scrolled}`)
    }

    if (matches(commandPath, ['goto'])) {
      const url = getRequiredStringFlag(parsed.flags, 'url')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      // Why: navigation waits for network idle which can exceed the default 15s RPC timeout
      const result = await client.call<BrowserGotoResult>(
        'browser.goto',
        { url, ...target },
        { timeoutMs: 60_000 }
      )
      return printResult(result, json, (v) => `Navigated to ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['back'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserBackResult>('browser.back', target)
      return printResult(result, json, (v) => `Back to ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['reload'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserReloadResult>('browser.reload', target, {
        timeoutMs: 60_000
      })
      return printResult(result, json, (v) => `Reloaded ${v.url} — ${v.title}`)
    }

    if (matches(commandPath, ['eval'])) {
      const expression = getRequiredStringFlag(parsed.flags, 'expression')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserEvalResult>('browser.eval', { expression, ...target })
      return printResult(result, json, (v) => v.result)
    }

    if (matches(commandPath, ['tab', 'list'])) {
      const worktree = await getBrowserWorktreeSelector(parsed.flags, cwd, client)
      const result = await client.call<BrowserTabListResult>('browser.tabList', { worktree })
      return printResult(result, json, formatTabList)
    }

    if (matches(commandPath, ['tab', 'switch'])) {
      const index = getOptionalNonNegativeIntegerFlag(parsed.flags, 'index')
      const page = getOptionalStringFlag(parsed.flags, 'page')
      if (index === undefined && !page) {
        throw new RuntimeClientError('invalid_argument', 'Missing required --index or --page')
      }
      // Why: a stable browser page id is globally unique across Orca, so page-
      // targeted tab switches should match the rest of the --page command model:
      // global by default, with --worktree only acting as explicit validation.
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserTabSwitchResult>('browser.tabSwitch', {
        index,
        page,
        ...target
      })
      return printResult(result, json, (v) => `Switched to tab ${v.switched} (${v.browserPageId})`)
    }

    if (matches(commandPath, ['tab', 'create'])) {
      const url = getOptionalStringFlag(parsed.flags, 'url')
      const worktree = await getBrowserWorktreeSelector(parsed.flags, cwd, client)
      const result = await client.call<{ browserPageId: string }>(
        'browser.tabCreate',
        { url, worktree },
        { timeoutMs: 60_000 }
      )
      return printResult(result, json, (v) => `Created tab ${v.browserPageId}`)
    }

    if (matches(commandPath, ['tab', 'close'])) {
      const index = getOptionalNonNegativeIntegerFlag(parsed.flags, 'index')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<{ closed: boolean }>('browser.tabClose', {
        index,
        ...target
      })
      return printResult(result, json, () => 'Tab closed')
    }

    if (matches(commandPath, ['exec'])) {
      const command = getRequiredStringFlag(parsed.flags, 'command')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.exec', { command, ...target })
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    if (matches(commandPath, ['wait'])) {
      const selector = getOptionalStringFlag(parsed.flags, 'selector')
      const timeout = getOptionalPositiveIntegerFlag(parsed.flags, 'timeout')
      const text = getOptionalStringFlag(parsed.flags, 'text')
      const url = getOptionalStringFlag(parsed.flags, 'url')
      const load = getOptionalStringFlag(parsed.flags, 'load')
      const fn = getOptionalStringFlag(parsed.flags, 'fn')
      const state = getOptionalStringFlag(parsed.flags, 'state')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserWaitResult>(
        'browser.wait',
        {
          selector,
          timeout,
          text,
          url,
          load,
          fn,
          state,
          ...target
        },
        {
          // Why: selector/text/url waits can legitimately take longer than a
          // normal RPC round-trip, even when Orca is healthy. Give browser.wait
          // an explicit timeout budget so slow waits do not get mislabeled as
          // "Orca is not running" by the generic client timeout path.
          timeoutMs: timeout ? timeout + 5000 : DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS
        }
      )
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    if (matches(commandPath, ['check']) || matches(commandPath, ['uncheck'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const checked = matches(commandPath, ['check'])
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserCheckResult>('browser.check', {
        element,
        checked,
        ...target
      })
      return printResult(result, json, (v) =>
        v.checked ? `Checked ${element}` : `Unchecked ${element}`
      )
    }

    if (matches(commandPath, ['focus'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserFocusResult>('browser.focus', { element, ...target })
      return printResult(result, json, (v) => `Focused ${v.focused}`)
    }

    if (matches(commandPath, ['clear'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserClearResult>('browser.clear', { element, ...target })
      return printResult(result, json, (v) => `Cleared ${v.cleared}`)
    }

    if (matches(commandPath, ['select-all'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserSelectAllResult>('browser.selectAll', {
        element,
        ...target
      })
      return printResult(result, json, (v) => `Selected all in ${v.selected}`)
    }

    if (matches(commandPath, ['keypress'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserKeypressResult>('browser.keypress', {
        key,
        ...target
      })
      return printResult(result, json, (v) => `Pressed ${v.pressed}`)
    }

    if (matches(commandPath, ['pdf'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserPdfResult>('browser.pdf', target)
      return printResult(result, json, (v) => `PDF exported (${v.data.length} bytes base64)`)
    }

    if (matches(commandPath, ['full-screenshot'])) {
      const format = getOptionalStringFlag(parsed.flags, 'format') === 'jpeg' ? 'jpeg' : 'png'
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserScreenshotResult>('browser.fullScreenshot', {
        format,
        ...target
      })
      return printResult(result, json, (v) => `Full-page screenshot captured (${v.format})`)
    }

    if (matches(commandPath, ['hover'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserHoverResult>('browser.hover', { element, ...target })
      return printResult(result, json, (v) => `Hovered ${v.hovered}`)
    }

    if (matches(commandPath, ['drag'])) {
      const from = getRequiredStringFlag(parsed.flags, 'from')
      const to = getRequiredStringFlag(parsed.flags, 'to')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserDragResult>('browser.drag', { from, to, ...target })
      return printResult(result, json, (v) => `Dragged ${v.dragged.from} → ${v.dragged.to}`)
    }

    if (matches(commandPath, ['upload'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const filesStr = getRequiredStringFlag(parsed.flags, 'files')
      const files = filesStr.split(',').map((f) => f.trim())
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserUploadResult>('browser.upload', {
        element,
        files,
        ...target
      })
      return printResult(result, json, (v) => `Uploaded ${v.uploaded} file(s)`)
    }

    // ── Cookie management ──

    if (matches(commandPath, ['cookie', 'get'])) {
      const url = getOptionalStringFlag(parsed.flags, 'url')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserCookieGetResult>('browser.cookie.get', {
        url,
        ...target
      })
      return printResult(result, json, (v) => {
        if (v.cookies.length === 0) {
          return 'No cookies'
        }
        return v.cookies.map((c) => `${c.name}=${c.value} (${c.domain})`).join('\n')
      })
    }

    if (matches(commandPath, ['cookie', 'set'])) {
      const name = getRequiredStringFlag(parsed.flags, 'name')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const params: Record<string, unknown> = { name, value }
      const domain = getOptionalStringFlag(parsed.flags, 'domain')
      const path = getOptionalStringFlag(parsed.flags, 'path')
      const sameSite = getOptionalStringFlag(parsed.flags, 'sameSite')
      const expires = getOptionalStringFlag(parsed.flags, 'expires')
      if (domain) {
        params.domain = domain
      }
      if (path) {
        params.path = path
      }
      if (parsed.flags.has('secure')) {
        params.secure = true
      }
      if (parsed.flags.has('httpOnly')) {
        params.httpOnly = true
      }
      if (sameSite) {
        params.sameSite = sameSite
      }
      if (expires) {
        params.expires = Number(expires)
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserCookieSetResult>('browser.cookie.set', params)
      return printResult(result, json, (v) =>
        v.success ? `Cookie "${name}" set` : `Failed to set cookie "${name}"`
      )
    }

    if (matches(commandPath, ['cookie', 'delete'])) {
      const name = getRequiredStringFlag(parsed.flags, 'name')
      const params: Record<string, unknown> = { name }
      const domain = getOptionalStringFlag(parsed.flags, 'domain')
      const url = getOptionalStringFlag(parsed.flags, 'url')
      if (domain) {
        params.domain = domain
      }
      if (url) {
        params.url = url
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserCookieDeleteResult>('browser.cookie.delete', params)
      return printResult(result, json, () => `Cookie "${name}" deleted`)
    }

    // ── Viewport ──

    if (matches(commandPath, ['viewport'])) {
      const width = getRequiredPositiveNumber(parsed.flags, 'width')
      const height = getRequiredPositiveNumber(parsed.flags, 'height')
      const params: Record<string, unknown> = { width, height }
      const scale = getOptionalStringFlag(parsed.flags, 'scale')
      if (scale) {
        const n = Number(scale)
        if (!Number.isFinite(n) || n <= 0) {
          throw new RuntimeClientError('invalid_argument', '--scale must be a positive number')
        }
        params.deviceScaleFactor = n
      }
      if (parsed.flags.has('mobile')) {
        params.mobile = true
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserViewportResult>('browser.viewport', params)
      return printResult(
        result,
        json,
        (v) => `Viewport set to ${v.width}×${v.height}${v.mobile ? ' (mobile)' : ''}`
      )
    }

    // ── Geolocation ──

    if (matches(commandPath, ['geolocation'])) {
      const latitude = getRequiredFiniteNumber(parsed.flags, 'latitude')
      const longitude = getRequiredFiniteNumber(parsed.flags, 'longitude')
      const params: Record<string, unknown> = { latitude, longitude }
      const accuracy = getOptionalStringFlag(parsed.flags, 'accuracy')
      if (accuracy) {
        const n = Number(accuracy)
        if (!Number.isFinite(n) || n <= 0) {
          throw new RuntimeClientError('invalid_argument', '--accuracy must be a positive number')
        }
        params.accuracy = n
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserGeolocationResult>('browser.geolocation', params)
      return printResult(result, json, (v) => `Geolocation set to ${v.latitude}, ${v.longitude}`)
    }

    // ── Request interception ──

    if (matches(commandPath, ['intercept', 'enable'])) {
      const params: Record<string, unknown> = {}
      const patternsStr = getOptionalStringFlag(parsed.flags, 'patterns')
      if (patternsStr) {
        params.patterns = patternsStr.split(',').map((p) => p.trim())
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserInterceptEnableResult>(
        'browser.intercept.enable',
        params
      )
      return printResult(
        result,
        json,
        (v) => `Interception enabled for: ${(v.patterns ?? []).join(', ') || '*'}`
      )
    }

    if (matches(commandPath, ['intercept', 'disable'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserInterceptDisableResult>(
        'browser.intercept.disable',
        target
      )
      return printResult(result, json, () => 'Interception disabled')
    }

    if (matches(commandPath, ['intercept', 'list'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<{ requests: BrowserInterceptedRequest[] }>(
        'browser.intercept.list',
        target
      )
      return printResult(result, json, (v) => {
        if (v.requests.length === 0) {
          return 'No paused requests'
        }
        return v.requests
          .map((r) => `[${r.id}] ${r.method} ${r.url} (${r.resourceType})`)
          .join('\n')
      })
    }

    // ── Console/network capture ──

    if (matches(commandPath, ['capture', 'start'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserCaptureStartResult>('browser.capture.start', target)
      return printResult(result, json, () => 'Capture started (console + network)')
    }

    if (matches(commandPath, ['capture', 'stop'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<BrowserCaptureStopResult>('browser.capture.stop', target)
      return printResult(result, json, () => 'Capture stopped')
    }

    if (matches(commandPath, ['console'])) {
      const params: Record<string, unknown> = {}
      const limit = getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      if (limit !== undefined) {
        params.limit = limit
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserConsoleResult>('browser.console', params)
      return printResult(result, json, (v) => {
        if (v.entries.length === 0) {
          return 'No console entries'
        }
        return v.entries.map((e) => `[${e.level}] ${e.text}`).join('\n')
      })
    }

    if (matches(commandPath, ['network'])) {
      const params: Record<string, unknown> = {}
      const limit = getOptionalPositiveIntegerFlag(parsed.flags, 'limit')
      if (limit !== undefined) {
        params.limit = limit
      }
      Object.assign(params, await getBrowserCommandTarget(parsed.flags, cwd, client))
      const result = await client.call<BrowserNetworkLogResult>('browser.network', params)
      return printResult(result, json, (v) => {
        if (v.entries.length === 0) {
          return 'No network entries'
        }
        return v.entries.map((e) => `${e.status} ${e.url} (${e.mimeType}, ${e.size}B)`).join('\n')
      })
    }

    // ── Additional core commands ──

    if (matches(commandPath, ['dblclick'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.dblclick', { element, ...target })
      return printResult(result, json, () => `Double-clicked ${element}`)
    }

    if (matches(commandPath, ['forward'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.forward', target)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return printResult(result, json, (v: any) =>
        v?.url ? `Navigated forward to ${v.url}` : 'Navigated forward'
      )
    }

    if (matches(commandPath, ['scrollintoview'])) {
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.scrollIntoView', { element, ...target })
      return printResult(result, json, () => `Scrolled ${element} into view`)
    }

    if (matches(commandPath, ['get'])) {
      const what = getRequiredStringFlag(parsed.flags, 'what')
      const element = getOptionalStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.get', {
        what,
        selector: element,
        ...target
      })
      return printResult(result, json, (v) =>
        typeof v === 'string' ? v : JSON.stringify(v, null, 2)
      )
    }

    if (matches(commandPath, ['is'])) {
      const what = getRequiredStringFlag(parsed.flags, 'what')
      const element = getRequiredStringFlag(parsed.flags, 'element')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.is', {
        what,
        selector: element,
        ...target
      })
      return printResult(result, json, (v) => String(v))
    }

    // ── Keyboard insert text ──

    if (matches(commandPath, ['inserttext'])) {
      const text = getRequiredStringFlag(parsed.flags, 'text')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.keyboardInsertText', { text, ...target })
      return printResult(result, json, () => 'Text inserted')
    }

    // ── Mouse commands ──

    if (matches(commandPath, ['mouse', 'move'])) {
      const x = getRequiredFiniteNumber(parsed.flags, 'x')
      const y = getRequiredFiniteNumber(parsed.flags, 'y')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.mouseMove', { x, y, ...target })
      return printResult(result, json, () => `Mouse moved to ${x},${y}`)
    }

    if (matches(commandPath, ['mouse', 'down'])) {
      const button = getOptionalStringFlag(parsed.flags, 'button')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.mouseDown', { button, ...target })
      return printResult(result, json, () => `Mouse button ${button ?? 'left'} pressed`)
    }

    if (matches(commandPath, ['mouse', 'up'])) {
      const button = getOptionalStringFlag(parsed.flags, 'button')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.mouseUp', { button, ...target })
      return printResult(result, json, () => `Mouse button ${button ?? 'left'} released`)
    }

    if (matches(commandPath, ['mouse', 'wheel'])) {
      const dy = getRequiredFiniteNumber(parsed.flags, 'dy')
      const dx = getOptionalNumberFlag(parsed.flags, 'dx')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.mouseWheel', { dy, dx, ...target })
      return printResult(
        result,
        json,
        () => `Mouse wheel scrolled dy=${dy}${dx != null ? ` dx=${dx}` : ''}`
      )
    }

    // ── Find (semantic locators) ──

    if (matches(commandPath, ['find'])) {
      const locator = getRequiredStringFlag(parsed.flags, 'locator')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const action = getRequiredStringFlag(parsed.flags, 'action')
      const text = getOptionalStringFlag(parsed.flags, 'text')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.find', {
        locator,
        value,
        action,
        text,
        ...target
      })
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    // ── Set commands ──

    if (matches(commandPath, ['set', 'device'])) {
      const name = getRequiredStringFlag(parsed.flags, 'name')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.setDevice', { name, ...target })
      return printResult(result, json, () => `Device emulation set to ${name}`)
    }

    if (matches(commandPath, ['set', 'offline'])) {
      const state = getOptionalStringFlag(parsed.flags, 'state')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.setOffline', { state, ...target })
      return printResult(result, json, () => `Offline mode ${state ?? 'toggled'}`)
    }

    if (matches(commandPath, ['set', 'headers'])) {
      const headers = getRequiredStringFlag(parsed.flags, 'headers')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.setHeaders', { headers, ...target })
      return printResult(result, json, () => 'Extra HTTP headers set')
    }

    if (matches(commandPath, ['set', 'credentials'])) {
      const user = getRequiredStringFlag(parsed.flags, 'user')
      const pass = getRequiredStringFlag(parsed.flags, 'pass')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.setCredentials', {
        user,
        pass,
        ...target
      })
      return printResult(result, json, () => `HTTP auth credentials set for ${user}`)
    }

    if (matches(commandPath, ['set', 'media'])) {
      const colorScheme = getOptionalStringFlag(parsed.flags, 'color-scheme')
      const reducedMotion = getOptionalStringFlag(parsed.flags, 'reduced-motion')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.setMedia', {
        colorScheme,
        reducedMotion,
        ...target
      })
      return printResult(result, json, () => 'Media preferences set')
    }

    // ── Clipboard commands ──

    if (matches(commandPath, ['clipboard', 'read'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.clipboardRead', target)
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    if (matches(commandPath, ['clipboard', 'write'])) {
      const text = getRequiredStringFlag(parsed.flags, 'text')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.clipboardWrite', { text, ...target })
      return printResult(result, json, () => 'Clipboard updated')
    }

    // ── Dialog commands ──

    if (matches(commandPath, ['dialog', 'accept'])) {
      const text = getOptionalStringFlag(parsed.flags, 'text')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.dialogAccept', { text, ...target })
      return printResult(result, json, () => 'Dialog accepted')
    }

    if (matches(commandPath, ['dialog', 'dismiss'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.dialogDismiss', target)
      return printResult(result, json, () => 'Dialog dismissed')
    }

    // ── Storage commands ──

    if (matches(commandPath, ['storage', 'local', 'get'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.local.get', { key, ...target })
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    if (matches(commandPath, ['storage', 'local', 'set'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.local.set', {
        key,
        value,
        ...target
      })
      return printResult(result, json, () => `localStorage["${key}"] set`)
    }

    if (matches(commandPath, ['storage', 'local', 'clear'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.local.clear', target)
      return printResult(result, json, () => 'localStorage cleared')
    }

    if (matches(commandPath, ['storage', 'session', 'get'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.session.get', { key, ...target })
      return printResult(result, json, (v) => JSON.stringify(v, null, 2))
    }

    if (matches(commandPath, ['storage', 'session', 'set'])) {
      const key = getRequiredStringFlag(parsed.flags, 'key')
      const value = getRequiredStringFlag(parsed.flags, 'value')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.session.set', {
        key,
        value,
        ...target
      })
      return printResult(result, json, () => `sessionStorage["${key}"] set`)
    }

    if (matches(commandPath, ['storage', 'session', 'clear'])) {
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.storage.session.clear', target)
      return printResult(result, json, () => 'sessionStorage cleared')
    }

    // ── Download command ──

    if (matches(commandPath, ['download'])) {
      const selector = getRequiredStringFlag(parsed.flags, 'selector')
      const path = getRequiredStringFlag(parsed.flags, 'path')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.download', { selector, path, ...target })
      return printResult(result, json, () => `Downloaded to ${path}`)
    }

    // ── Highlight command ──

    if (matches(commandPath, ['highlight'])) {
      const selector = getRequiredStringFlag(parsed.flags, 'selector')
      const target = await getBrowserCommandTarget(parsed.flags, cwd, client)
      const result = await client.call<unknown>('browser.highlight', { selector, ...target })
      return printResult(result, json, () => `Highlighted ${selector}`)
    }

    throw new RuntimeClientError('invalid_argument', `Unknown command: ${commandPath.join(' ')}`)
  } catch (error) {
    if (json) {
      if (error instanceof RuntimeRpcFailureError) {
        console.log(JSON.stringify(error.response, null, 2))
      } else {
        const response: RuntimeRpcFailure = {
          id: 'local',
          ok: false,
          error: {
            code: error instanceof RuntimeClientError ? error.code : 'runtime_error',
            message: formatCliError(error)
          },
          _meta: {
            runtimeId: null
          }
        }
        console.log(JSON.stringify(response, null, 2))
      }
    } else {
      console.error(formatCliError(error))
    }
    process.exitCode = 1
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const commandPath: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const flag = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      flags.set(flag, true)
      continue
    }
    flags.set(flag, next)
    i += 1
  }

  return { commandPath, flags }
}

export function resolveHelpPath(parsed: ParsedArgs): string[] | null {
  if (parsed.commandPath[0] === 'help') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help')) {
    return parsed.commandPath
  }
  return null
}

export function validateCommandAndFlags(parsed: ParsedArgs): void {
  const spec = findCommandSpec(parsed.commandPath)
  if (!spec) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }

  for (const flag of parsed.flags.keys()) {
    if (
      !spec.allowedFlags.includes(flag) &&
      !(flag === 'page' && supportsBrowserPageFlag(spec.path))
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${spec.path.join(' ')}`
      )
    }
  }
}

export function findCommandSpec(commandPath: string[]): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => matches(spec.path, commandPath))
}

function supportsBrowserPageFlag(commandPath: string[]): boolean {
  const joined = commandPath.join(' ')
  if (['open', 'status'].includes(commandPath[0])) {
    return false
  }
  if (['repo', 'worktree', 'terminal'].includes(commandPath[0])) {
    return false
  }
  return !['tab list', 'tab create'].includes(joined)
}

function isCommandGroup(commandPath: string[]): boolean {
  return (
    (commandPath.length === 1 &&
      [
        'repo',
        'worktree',
        'terminal',
        'tab',
        'cookie',
        'intercept',
        'capture',
        'mouse',
        'set',
        'clipboard',
        'dialog',
        'storage'
      ].includes(commandPath[0])) ||
    (commandPath.length === 2 &&
      commandPath[0] === 'storage' &&
      ['local', 'session'].includes(commandPath[1]))
  )
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
}

function getOptionalStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildCurrentWorktreeSelector(cwd: string): string {
  return `path:${resolvePath(cwd)}`
}

export function normalizeWorktreeSelector(selector: string, cwd: string): string {
  if (selector === 'active' || selector === 'current') {
    return buildCurrentWorktreeSelector(cwd)
  }
  return selector
}

function isWithinPath(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

async function resolveCurrentWorktreeSelector(cwd: string, client: RuntimeClient): Promise<string> {
  const currentPath = resolvePath(cwd)
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  const enclosingWorktree = worktrees.result.worktrees
    .filter((worktree) => isWithinPath(resolvePath(worktree.path), currentPath))
    .sort((left, right) => right.path.length - left.path.length)[0]

  if (!enclosingWorktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${currentPath}`
    )
  }

  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. The CLI resolves that shell-local concept
  // to the deepest matching worktree root, then hands the runtime a normal
  // path selector so selector semantics stay centralized in one layer.
  return buildCurrentWorktreeSelector(enclosingWorktree.path)
}

async function getOptionalWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, name)
  if (!value) {
    return undefined
  }
  if (value === 'active' || value === 'current') {
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return normalizeWorktreeSelector(value, cwd)
}

async function getRequiredWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const value = getRequiredStringFlag(flags, name)
  if (value === 'active' || value === 'current') {
    return await resolveCurrentWorktreeSelector(cwd, client)
  }
  return normalizeWorktreeSelector(value, cwd)
}

// Why: browser commands default to the current worktree (auto-resolve from cwd).
// --worktree all bypasses filtering. Omitting --worktree auto-resolves.
async function getBrowserWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, 'worktree')
  if (value === 'all') {
    return undefined
  }
  if (value) {
    if (value === 'active' || value === 'current') {
      return await resolveCurrentWorktreeSelector(cwd, client)
    }
    return normalizeWorktreeSelector(value, cwd)
  }
  // Default: auto-resolve from cwd
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch {
    // Not inside a managed worktree — no filter
    return undefined
  }
}

// Why: mirrors browser's implicit active-tab targeting. When --terminal is
// omitted, resolve the active terminal in the current worktree so commands
// like `orca terminal send --text "hello" --enter` Just Work.
async function getTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const explicit = getOptionalStringFlag(flags, 'terminal')
  if (explicit) {
    return explicit
  }
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  const response = await client.call<{ handle: string }>('terminal.resolveActive', { worktree })
  return response.result.handle
}

async function getBrowserCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<BrowserCliTarget> {
  const page = getOptionalStringFlag(flags, 'page')
  if (!page) {
    return {
      worktree: await getBrowserWorktreeSelector(flags, cwd, client)
    }
  }

  const explicitWorktree = getOptionalStringFlag(flags, 'worktree')
  if (!explicitWorktree || explicitWorktree === 'all') {
    return { page }
  }
  if (explicitWorktree === 'active' || explicitWorktree === 'current') {
    return {
      page,
      worktree: await resolveCurrentWorktreeSelector(cwd, client)
    }
  }
  return {
    page,
    worktree: normalizeWorktreeSelector(explicitWorktree, cwd)
  }
}

function getOptionalNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

function getOptionalPositiveIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

function getOptionalNonNegativeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError('invalid_argument', `Invalid non-negative integer for --${name}`)
  }
  return value
}

function getRequiredPositiveNumber(flags: Map<string, string | boolean>, name: string): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a positive number`)
  }
  return value
}

function getRequiredFiniteNumber(flags: Map<string, string | boolean>, name: string): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a valid number`)
  }
  return value
}

function getOptionalNullableNumberFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | null | undefined {
  const value = flags.get(name)
  if (value === 'null') {
    return null
  }
  return getOptionalNumberFlag(flags, name)
}

export function matches(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
}

function printResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  console.log(formatter(response.result))
}

function formatStatus(status: CliStatusResult): string {
  return formatCliStatus(status)
}

function formatCliStatus(status: CliStatusResult): string {
  return [
    `appRunning: ${status.app.running}`,
    `pid: ${status.app.pid ?? 'none'}`,
    `runtimeState: ${status.runtime.state}`,
    `runtimeReachable: ${status.runtime.reachable}`,
    `runtimeId: ${status.runtime.runtimeId ?? 'none'}`,
    `graphState: ${status.graph.state}`
  ].join('\n')
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return `${message}\nOrca is not running. Run 'orca open' first.`
  }
  return message
}

function formatTerminalList(result: RuntimeTerminalListResult): string {
  if (result.terminals.length === 0) {
    return 'No live terminals.'
  }
  const body = result.terminals
    .map(
      (terminal) =>
        `${terminal.handle}  ${terminal.title ?? '(untitled)'}  ${terminal.connected ? 'connected' : 'disconnected'}  ${terminal.worktreePath}\n${terminal.preview ? `preview: ${terminal.preview}` : 'preview: <empty>'}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.terminals.length} of ${result.totalCount}`
    : body
}

function formatTerminalShow(result: { terminal: RuntimeTerminalShow }): string {
  const terminal = result.terminal
  return [
    `handle: ${terminal.handle}`,
    `title: ${terminal.title ?? '(untitled)'}`,
    `worktree: ${terminal.worktreePath}`,
    `branch: ${terminal.branch}`,
    `leaf: ${terminal.leafId}`,
    `ptyId: ${terminal.ptyId ?? 'none'}`,
    `connected: ${terminal.connected}`,
    `writable: ${terminal.writable}`,
    `preview: ${terminal.preview || '<empty>'}`
  ].join('\n')
}

function formatTerminalRead(result: { terminal: RuntimeTerminalRead }): string {
  const terminal = result.terminal
  const header = [
    `handle: ${terminal.handle}`,
    `status: ${terminal.status}`,
    ...(terminal.nextCursor !== null ? [`cursor: ${terminal.nextCursor}`] : [])
  ]
  return [...header, '', ...terminal.tail].join('\n')
}

function formatTerminalSend(result: { send: RuntimeTerminalSend }): string {
  return `Sent ${result.send.bytesWritten} bytes to ${result.send.handle}.`
}

function formatTerminalRename(result: { rename: RuntimeTerminalRename }): string {
  return result.rename.title
    ? `Renamed terminal ${result.rename.handle} to "${result.rename.title}".`
    : `Cleared title for terminal ${result.rename.handle}.`
}

function formatTerminalCreate(result: { terminal: RuntimeTerminalCreate }): string {
  const titleNote = result.terminal.title ? ` (title: "${result.terminal.title}")` : ''
  return `Created terminal ${result.terminal.handle}${titleNote}`
}

function formatTerminalSplit(result: { split: RuntimeTerminalSplit }): string {
  return `Split pane ${result.split.handle} in tab ${result.split.tabId}`
}

function formatTerminalFocus(result: { focus: RuntimeTerminalFocus }): string {
  return `Focused terminal ${result.focus.handle} (tab ${result.focus.tabId}).`
}

function formatTerminalClose(result: { close: RuntimeTerminalClose }): string {
  const ptyNote = result.close.ptyKilled ? ' PTY killed.' : ''
  return `Closed terminal ${result.close.handle}.${ptyNote}`
}

function formatTerminalWait(result: { wait: RuntimeTerminalWait }): string {
  return [
    `handle: ${result.wait.handle}`,
    `condition: ${result.wait.condition}`,
    `satisfied: ${result.wait.satisfied}`,
    `status: ${result.wait.status}`,
    `exitCode: ${result.wait.exitCode ?? 'null'}`
  ].join('\n')
}

function formatWorktreePs(result: RuntimeWorktreePsResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${worktree.repo} ${worktree.branch}  live:${worktree.liveTerminalCount}  pty:${worktree.hasAttachedPty ? 'yes' : 'no'}  unread:${worktree.unread ? 'yes' : 'no'}\n${worktree.path}${worktree.preview ? `\npreview: ${worktree.preview}` : ''}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

function formatRepoList(result: RuntimeRepoList): string {
  if (result.repos.length === 0) {
    return 'No repos found.'
  }
  return result.repos.map((repo) => `${repo.id}  ${repo.displayName}  ${repo.path}`).join('\n')
}

function formatRepoShow(result: { repo: Record<string, unknown> }): string {
  return Object.entries(result.repo)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

function formatRepoRefs(result: RuntimeRepoSearchRefs): string {
  if (result.refs.length === 0) {
    return 'No refs found.'
  }
  return result.truncated ? `${result.refs.join('\n')}\n\ntruncated: yes` : result.refs.join('\n')
}

function formatWorktreeList(result: RuntimeWorktreeListResult): string {
  if (result.worktrees.length === 0) {
    return 'No worktrees found.'
  }
  const body = result.worktrees
    .map(
      (worktree) =>
        `${String(worktree.id)}  ${String(worktree.branch)}  ${String(worktree.path)}\ndisplayName: ${String(worktree.displayName ?? '')}\nlinkedIssue: ${String(worktree.linkedIssue ?? 'null')}\ncomment: ${String(worktree.comment ?? '')}`
    )
    .join('\n\n')
  return result.truncated
    ? `${body}\n\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : body
}

function formatWorktreeShow(result: { worktree: RuntimeWorktreeRecord }): string {
  const worktree = result.worktree
  return Object.entries(worktree)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
    .join('\n')
}

function formatSnapshot(result: BrowserSnapshotResult): string {
  const header = `page: ${result.browserPageId}\n${result.title} — ${result.url}\n`
  return header + result.snapshot
}

function formatScreenshot(result: BrowserScreenshotResult): string {
  return `Screenshot captured (${result.format}, ${Math.round(result.data.length * 0.75)} bytes)`
}

function formatTabList(result: BrowserTabListResult): string {
  if (result.tabs.length === 0) {
    return 'No browser tabs open.'
  }
  return result.tabs
    .map((t) => {
      const marker = t.active ? '* ' : '  '
      return `${marker}[${t.index}] ${t.browserPageId}  ${t.title} — ${t.url}`
    })
    .join('\n')
}

function printHelp(commandPath: string[] = []): void {
  const exactSpec = findCommandSpec(commandPath)
  if (exactSpec) {
    console.log(formatCommandHelp(exactSpec))
    return
  }

  if (isCommandGroup(commandPath)) {
    console.log(formatGroupHelp(commandPath[0]))
    return
  }

  if (commandPath.length > 0) {
    console.log(`Unknown command: ${commandPath.join(' ')}\n`)
  }

  console.log(`orca

Usage: orca <command> [options]

Startup:
  open                      Launch Orca and wait for the runtime to be reachable
  status                    Show app/runtime/graph readiness

Repos:
  repo list                 List repos registered in Orca
  repo add                  Add a project to Orca by filesystem path
  repo show                 Show one registered repo
  repo set-base-ref         Set the repo's default base ref for future worktrees
  repo search-refs          Search branch/tag refs within a repo

Worktrees:
  worktree list             List Orca-managed worktrees
  worktree show             Show one worktree
  worktree current          Show the Orca-managed worktree for the current directory
  worktree create           Create a new Orca-managed worktree
  worktree set              Update Orca metadata for a worktree
  worktree rm               Remove a worktree from Orca and git
  worktree ps               Show a compact orchestration summary across worktrees

Terminals:
  terminal list             List live Orca-managed terminals
  terminal show             Show terminal metadata and preview
  terminal read             Read bounded terminal output
  terminal send             Send input to a live terminal
  terminal wait             Wait for a terminal condition (exit, tui-idle)
  terminal stop             Stop terminals for a worktree
  terminal create           Create a new terminal tab in a worktree
  terminal rename           Set or clear the title of a terminal tab
  terminal split            Split an existing terminal pane
  terminal switch           Bring a terminal tab to the foreground
  terminal focus            Alias for terminal switch
  terminal close            Close a terminal pane (or tab if last pane)

Browser Automation:
  tab create                Create a new browser tab (navigates to --url)
  tab list                  List open browser tabs
  tab switch                Switch the active browser tab by --index or --page
  tab close                 Close a browser tab by --index/--page or the current tab
  snapshot                  Accessibility snapshot with element refs (e.g. @e1, @e2)
  goto                      Navigate the active tab to --url
  click                     Click element by --element ref
  fill                      Clear and fill input by --element ref with --value
  type                      Type --input text at the current focus (no element needed)
  select                    Select dropdown option by --element ref and --value
  hover                     Hover element by --element ref
  keypress                  Press a key (e.g. --key Enter, --key Tab)
  scroll                    Scroll --direction (up/down) by --amount pixels
  back                      Navigate back in browser history
  reload                    Reload the active browser tab
  screenshot                Capture viewport screenshot (--format png|jpeg)
  eval                      Evaluate --expression JavaScript in the page context
  wait                      Wait for page idle or --timeout ms
  check                     Check a checkbox by --element ref
  uncheck                   Uncheck a checkbox by --element ref
  focus                     Focus an element by --element ref
  clear                     Clear an input by --element ref
  drag                      Drag --from ref to --to ref
  upload                    Upload --files to a file input by --element ref
  dblclick                  Double-click element by --element ref
  forward                   Navigate forward in browser history
  scrollintoview            Scroll --element into view
  get                       Get element property (--what: text, html, value, url, title)
  is                        Check element state (--what: visible, enabled, checked)
  inserttext                Insert text without key events
  mouse move                Move mouse to --x --y coordinates
  mouse down                Press mouse button
  mouse up                  Release mouse button
  mouse wheel               Scroll wheel --dy [--dx]
  find                      Find element by locator (--locator role|text|label --value <v>)
  set device                Emulate device (--name "iPhone 12")
  set offline               Toggle offline mode (--state on|off)
  set headers               Set HTTP headers (--headers '{"key":"val"}')
  set credentials           Set HTTP auth (--user <u> --pass <p>)
  set media                 Set color scheme (--color-scheme dark|light)
  clipboard read            Read clipboard contents
  clipboard write           Write --text to clipboard
  dialog accept             Accept browser dialog (--text for prompt response)
  dialog dismiss            Dismiss browser dialog
  storage local get         Get localStorage value by --key
  storage local set         Set localStorage --key --value
  storage local clear       Clear localStorage
  storage session get       Get sessionStorage value by --key
  storage session set       Set sessionStorage --key --value
  storage session clear     Clear sessionStorage
  download                  Download file via --selector to --path
  highlight                 Highlight --selector on page
  exec                      Run any agent-browser command (--command "...")

Common Commands:
  orca open [--json]
  orca status [--json]
  orca worktree list [--repo <selector>] [--limit <n>] [--json]
  orca worktree create --repo <selector> --name <name> [--base-branch <ref>] [--issue <number>] [--comment <text>] [--json]
  orca worktree show --worktree <selector> [--json]
  orca worktree current [--json]
  orca worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--comment <text>] [--json]
  orca worktree rm --worktree <selector> [--force] [--json]
  orca worktree ps [--limit <n>] [--json]
  orca terminal list [--worktree <selector>] [--limit <n>] [--json]
  orca terminal show [--terminal <handle>] [--json]
  orca terminal read [--terminal <handle>] [--json]
  orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]
  orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]
  orca terminal stop --worktree <selector> [--json]
  orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--json]
  orca terminal split [--terminal <handle>] [--direction horizontal|vertical] [--json]
  orca terminal switch [--terminal <handle>] [--json]
  orca terminal close [--terminal <handle>] [--json]
  orca repo list [--json]
  orca repo add --path <path> [--json]
  orca repo show --repo <selector> [--json]
  orca repo set-base-ref --repo <selector> --ref <ref> [--json]
  orca repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]

Selectors:
  --repo <selector>         Registered repo selector such as id:<id>, name:<name>, or path:<path>
  --worktree <selector>     Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current
  --terminal <handle>       Runtime-issued terminal handle returned by \`orca terminal list --json\`

Terminal Send Options:
  --text <text>             Text to send to the terminal
  --enter                   Append Enter after sending text
  --interrupt               Send as an interrupt-style input when supported

Wait Options:
  --for exit                Wait until the target terminal exits
  --timeout-ms <ms>         Maximum wait time before timing out

Output Options:
  --json                    Emit machine-readable JSON instead of human text
  --help                    Show this help message

Behavior:
  Most commands require a running Orca runtime. If Orca is not open yet, run \`orca open\` first.
  Use selectors for discovery and handles for repeated live terminal operations.

Browser Workflow:
  1. Create or navigate:  orca tab create --url https://example.com
                          orca goto --url https://example.com
  2. Inspect the page:    orca snapshot
     (Returns an accessibility tree with element refs like e1, e2, e3)
     For concurrent workflows, prefer: orca tab list --json
     then reuse tabs[].browserPageId with --page <id> on later commands.
  3. Interact:            orca click --element e2
                          orca fill --element e5 --value "search query"
                          orca keypress --key Enter
  4. Re-inspect:          orca snapshot
     (Element refs change after navigation — always re-snapshot before interacting)

Browser Options:
  --element <ref>           Element ref from snapshot (e.g. @e3)
  --url <url>               URL to navigate to
  --value <text>            Value to fill or select
  --input <text>            Text to type at current focus (no element needed)
  --expression <js>         JavaScript expression to evaluate
  --key <key>               Key to press (Enter, Tab, Escape, Control+a, etc.)
  --direction <dir>         Scroll direction: up or down
  --amount <pixels>         Scroll distance in pixels (default: viewport height)
  --index <n>               Tab index (from \`tab list\`)
  --page <id>               Stable browser page id (preferred for concurrent workflows)
  --format <png|jpeg>       Screenshot image format
  --from <ref>              Drag source element ref
  --to <ref>                Drag target element ref
  --files <path,...>        Comma-separated file paths for upload
  --timeout <ms>            Wait timeout in milliseconds
  --worktree <selector>     Scope commands to a specific worktree's browser tabs

Examples:
  $ orca open
  $ orca status --json
  $ orca repo list
  $ orca worktree create --repo name:orca --name cli-test-1 --issue 273
  $ orca worktree show --worktree branch:Jinwoo-H/cli
  $ orca worktree current
  $ orca worktree set --worktree active --comment "waiting on review"
  $ orca worktree ps --limit 10
  $ orca terminal list --worktree path:/Users/me/orca/workspaces/orca/cli-test-1 --json
  $ orca terminal send --terminal term_123 --text "hi" --enter
  $ orca terminal wait --terminal term_123 --for exit --timeout-ms 60000 --json
  $ orca tab create --url https://example.com
  $ orca snapshot
  $ orca click --element e3
  $ orca fill --element e5 --value "hello"
  $ orca goto --url https://example.com/login
  $ orca keypress --key Enter
  $ orca eval --expression "document.title"
  $ orca tab list --json`)
}

function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`orca ${spec.path.join(' ')}`, '', `Usage: ${spec.usage}`, '', spec.summary]
  const displayedFlags = supportsBrowserPageFlag(spec.path)
    ? [...spec.allowedFlags, 'page']
    : spec.allowedFlags

  if (displayedFlags.length > 0) {
    lines.push('', 'Options:')
    for (const flag of displayedFlags) {
      lines.push(`  ${formatFlagHelp(flag)}`)
    }
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of spec.notes) {
      lines.push(`  ${note}`)
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('', 'Examples:')
    for (const example of spec.examples) {
      lines.push(`  $ ${example}`)
    }
  }

  return lines.join('\n')
}

function formatGroupHelp(group: string): string {
  const specs = COMMAND_SPECS.filter((spec) => spec.path[0] === group)
  const lines = [`orca ${group}`, '', `Usage: orca ${group} <command> [options]`, '', 'Commands:']
  for (const spec of specs) {
    lines.push(`  ${spec.path.slice(1).join(' ').padEnd(18)} ${spec.summary}`)
  }
  lines.push('', `Run \`orca ${group} <command> --help\` for command-specific usage.`)
  return lines.join('\n')
}

function formatFlagHelp(flag: string): string {
  const helpByFlag: Record<string, string> = {
    'base-branch': '--base-branch <ref>    Base branch/ref to create the worktree from',
    command: '--command <text>       Command to run in the terminal on startup',
    comment: '--comment <text>       Comment stored in Orca metadata',
    cursor: '--cursor <n>           Line cursor from a previous read (returns only new output)',
    direction: '--direction <dir>      Direction: horizontal|vertical (split) or up|down (scroll)',
    'display-name': '--display-name <name>  Override the Orca display name',
    title: '--title <text>         Custom title for the terminal tab (omit to reset)',
    enter: '--enter                Append Enter after sending text',
    force: '--force                Force worktree removal when supported',
    for: '--for exit|tui-idle    Wait condition to satisfy',
    help: '--help                 Show this help message',
    interrupt: '--interrupt            Send as an interrupt-style input when supported',
    issue: '--issue <number|null>  Linked GitHub issue number',
    json: '--json                 Emit machine-readable JSON',
    limit: '--limit <n>            Maximum number of rows to return',
    name: '--name <name>          Name for the new worktree',
    path: '--path <path>          Filesystem path to the repo',
    query: '--query <text>        Search text for matching refs',
    ref: '--ref <ref>            Base ref to persist for the repo',
    repo: '--repo <selector>      Repo selector such as id:<id>, name:<name>, or path:<path>',
    terminal: '--terminal <handle>  Runtime-issued terminal handle',
    text: '--text <text>          Text to send to the terminal',
    'timeout-ms': '--timeout-ms <ms>     Maximum wait time before timing out',
    worktree:
      '--worktree <selector>  Worktree selector such as id:<id>, branch:<branch>, issue:<number>, path:<path>, or active/current',
    // Browser automation flags
    element: '--element <ref>        Element ref from snapshot (e.g. e3)',
    url: '--url <url>            URL to navigate to',
    value: '--value <text>         Value to fill or select',
    input: '--input <text>         Text to type at current focus',
    expression: '--expression <js>     JavaScript expression to evaluate',
    amount: '--amount <pixels>      Scroll distance in pixels',
    index: '--index <n>            Tab index to switch to',
    page: '--page <id>            Stable browser page id from `orca tab list --json`',
    format: '--format <png|jpeg>    Screenshot image format'
  }

  return helpByFlag[flag] ?? `--${flag}`
}

if (require.main === module) {
  void main()
}
