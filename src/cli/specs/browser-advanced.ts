import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const BROWSER_ADVANCED_COMMAND_SPECS: CommandSpec[] = [
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
