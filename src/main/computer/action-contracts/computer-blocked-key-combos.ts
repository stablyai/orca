import { RuntimeClientError } from '../runtime-client-error'

// Design ported from vercel-labs/agent-desktop's per-platform blocked_combo lists (Apache-2.0).
type BlockedKeyCombo = {
  modifiers: readonly string[]
  keys: readonly string[]
  effect: string
}

type PlatformKeyRules = {
  modifierAliases: Readonly<Record<string, string>>
  keyAliases: Readonly<Record<string, string>>
  canonicalKey?: (key: string) => string
  // Most specific first so the error names what the combo would actually do.
  blocked: readonly BlockedKeyCombo[]
}

const SHARED_KEY_ALIASES = { esc: 'escape' }

// Aliases mirror how each provider maps modifier names to physical keys.
const MACOS_RULES: PlatformKeyRules = {
  modifierAliases: {
    cmd: 'cmd',
    command: 'cmd',
    meta: 'cmd',
    super: 'cmd',
    win: 'cmd',
    cmdorctrl: 'cmd',
    commandorcontrol: 'cmd',
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift'
  },
  // The macOS provider sends both names as the same physical Delete key.
  keyAliases: { ...SHARED_KEY_ALIASES, delete: 'backspace' },
  blocked: [
    { modifiers: ['cmd', 'ctrl'], keys: ['q'], effect: 'lock the screen' },
    { modifiers: ['cmd', 'shift'], keys: ['q'], effect: 'log out of macOS' },
    { modifiers: ['cmd', 'alt'], keys: ['escape'], effect: 'open the Force Quit window' },
    { modifiers: ['cmd', 'shift'], keys: ['backspace'], effect: 'empty the Trash' },
    { modifiers: ['cmd'], keys: ['q'], effect: 'quit the app' }
  ]
}

const WINDOWS_RULES: PlatformKeyRules = {
  modifierAliases: {
    ctrl: 'ctrl',
    control: 'ctrl',
    cmdorctrl: 'ctrl',
    commandorcontrol: 'ctrl',
    meta: 'win',
    super: 'win',
    win: 'win',
    cmd: 'win',
    command: 'win',
    alt: 'alt',
    option: 'alt',
    shift: 'shift'
  },
  keyAliases: SHARED_KEY_ALIASES,
  // Ctrl+Alt+Delete is absent: Windows never honors a synthesized Secure Attention Sequence.
  blocked: [
    { modifiers: ['alt'], keys: ['f4'], effect: 'close the app' },
    { modifiers: ['win'], keys: ['l'], effect: 'lock Windows' },
    { modifiers: ['ctrl', 'shift'], keys: ['escape'], effect: 'open Task Manager' }
  ]
}

const NUMERIC_KEYSYM = 'numeric keysym'

const LINUX_RULES: PlatformKeyRules = {
  modifierAliases: {
    ctrl: 'ctrl',
    control: 'ctrl',
    cmdorctrl: 'ctrl',
    commandorcontrol: 'ctrl',
    // xdotool sends Meta_L, which default XKB layouts put on the Alt modifier.
    meta: 'alt',
    super: 'super',
    win: 'super',
    cmd: 'super',
    command: 'super',
    alt: 'alt',
    option: 'alt',
    shift: 'shift'
  },
  // X11 names F11 and F12 L1 and L2 too.
  keyAliases: { ...SHARED_KEY_ALIASES, l1: 'f11', l2: 'f12' },
  // Xlib and GDK resolve 0x/U hex keysyms and drop an optional XF86 prefix; xdotool reads any
  // other token starting with a digit as a raw keycode (atoi ignores trailing text).
  canonicalKey: (key) =>
    /^(\d[\s\S]+|u[0-9a-f]+)$/.test(key) ? NUMERIC_KEYSYM : key.replace(/^xf86_?/, ''),
  blocked: [
    {
      modifiers: [],
      keys: [NUMERIC_KEYSYM],
      effect: 'send a numeric keysym or keycode that computer use cannot check'
    },
    {
      modifiers: [],
      keys: ['poweroff', 'powerdown', 'logoff', 'sleep', 'suspend', 'hibernate', 'standby'],
      effect: 'power off, suspend or log out of the session'
    },
    { modifiers: [], keys: ['screensaver'], effect: 'lock the screen' },
    {
      modifiers: [],
      keys: Array.from({ length: 12 }, (_, index) => `switch_vt_${index + 1}`),
      effect: 'switch to another virtual terminal'
    },
    { modifiers: [], keys: ['terminate_server'], effect: 'end the X session' },
    {
      modifiers: ['ctrl', 'alt'],
      keys: ['delete'],
      effect: 'open the log out and power off dialog'
    },
    { modifiers: ['ctrl', 'alt'], keys: ['backspace'], effect: 'end the X session' },
    {
      modifiers: ['ctrl', 'alt'],
      keys: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
      effect: 'switch to another virtual terminal'
    },
    { modifiers: ['ctrl', 'alt'], keys: ['l'], effect: 'lock the screen' },
    { modifiers: ['super'], keys: ['l'], effect: 'lock the screen' },
    { modifiers: ['alt'], keys: ['f4'], effect: 'close the window' },
    { modifiers: ['ctrl'], keys: ['q'], effect: 'quit the app' }
  ]
}

function platformKeyRules(platform: NodeJS.Platform): PlatformKeyRules {
  if (platform === 'darwin') {
    return MACOS_RULES
  }
  return platform === 'win32' ? WINDOWS_RULES : LINUX_RULES
}

// Extra modifiers still match: Cmd+Alt+Shift+Q logs out just like Cmd+Shift+Q.
function findBlockedKeyCombo(key: string, platform: NodeJS.Platform): BlockedKeyCombo | null {
  const rules = platformKeyRules(platform)
  const parts = key === '+' ? ['+'] : key.split('+')
  const modifiers = new Set<string>()
  let keyName = ''
  for (const part of parts) {
    const normalized = part.trim().toLowerCase()
    const modifier = rules.modifierAliases[normalized.replace(/[\s_-]/g, '')]
    if (modifier) {
      modifiers.add(modifier)
    } else {
      const aliased = rules.keyAliases[normalized] ?? normalized
      keyName = rules.canonicalKey ? rules.canonicalKey(aliased) : aliased
    }
  }
  return (
    rules.blocked.find(
      (combo) =>
        combo.keys.includes(keyName) && combo.modifiers.every((modifier) => modifiers.has(modifier))
    ) ?? null
  )
}

export function assertComputerKeyComboAllowed(
  params: Record<string, unknown>,
  key: string,
  platform: NodeJS.Platform
): void {
  if (params.allowSystemShortcut === true) {
    return
  }
  const blocked = findBlockedKeyCombo(key, platform)
  if (blocked) {
    throw new RuntimeClientError(
      'system_shortcut_blocked',
      `'${key}' would ${blocked.effect}, so computer use refuses it unless the caller passes --allow-system-shortcut`
    )
  }
}
