import { runProcess } from '@orca/process-host'
import {
  getKeyedSerializedQueueTail,
  runKeyedSerializedOperation
} from '../../shared/concurrency/keyed-serialized-operations'
import { readCurrentKeyboardLayoutSourceId } from '../ipc/keyboard/macos-keyboard-input-source'
import { readMacKeyboardLayoutSnapshot } from '../ipc/keyboard/macos-keyboard-layout-snapshot'

const SIMCTL_TIMEOUT_MS = 10_000
const MAC_APPLE_LAYOUT_PREFIX = 'com.apple.keylayout.'
// iOS reloads the hardware layout of running apps on this Darwin notification; a prefs write alone waits for a relaunch.
const KEYBOARDS_CHANGED_NOTIFICATION = 'AppleKeyboardsPreferencesChangedNotification'
const IOS_LAYOUTS_PLIST =
  'System/Library/KeyboardLayouts/USBKeyboardLayouts.bundle/USBKeyboardLayouts.plist'
// iOS's keyboard when AppleKeyboards is unset.
const DEFAULT_KEYBOARD = 'en_US@sw=QWERTY'
const AUTOMATIC_DEFAULT_KEYBOARD = `${DEFAULT_KEYBOARD};hw=Automatic`
const US_HARDWARE_LAYOUT = 'U.S.'

// USBKeyboardLayouts.plist: layout key to `{ KeyLayoutName, ... }`.
type IosKeyboardLayouts = Record<string, unknown>

/** Mac layout IDs drop the spaces and dots of the shared layout name ("U.S." is "US"). */
export function iosHardwareLayoutForMacLayout(
  macLayoutId: string,
  iosLayouts: IosKeyboardLayouts
): string | null {
  if (!macLayoutId.startsWith(MAC_APPLE_LAYOUT_PREFIX)) {
    return null
  }
  const macName = macLayoutId.slice(MAC_APPLE_LAYOUT_PREFIX.length)
  for (const [key, layout] of Object.entries(iosLayouts)) {
    if (key.replace(/[ .]/g, '') !== macName) {
      continue
    }
    const name =
      layout && typeof layout === 'object' && 'KeyLayoutName' in layout
        ? layout.KeyLayoutName
        : null
    return typeof name === 'string' ? name : key
  }
  return null
}

/** Parses `defaults read -g AppleKeyboards`; entries hold `@`, `;` and `=`, so defaults always quotes them. */
export function parseAppleKeyboardsDefaults(stdout: string): string[] {
  return [...stdout.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1].replace(/\\(.)/g, '$1')
  )
}

export function withHardwareLayout(entries: string[] | null, hardwareLayout: string): string[] {
  if (!entries?.length) {
    return [`${DEFAULT_KEYBOARD};hw=${hardwareLayout}`]
  }
  // Keyboards without a hardware layout (emoji) stay as they are.
  return entries.map((entry) => entry.replace(/([@;]hw=)[^;]*/, `$1${hardwareLayout}`))
}

/** Whether US key usages type the characters they name; anything else could be a different layout. */
export function isUSHardwareKeyboard(entries: string[] | null): boolean {
  return (entries ?? []).every((entry) => {
    const hardwareLayout = /[@;]hw=([^;]*)/.exec(entry)?.[1]
    if (hardwareLayout === undefined || hardwareLayout === US_HARDWARE_LAYOUT) {
      return true
    }
    return hardwareLayout === 'Automatic' && entry.startsWith(`${DEFAULT_KEYBOARD};`)
  })
}

function withoutHardwareLayout(entry: string): string {
  return entry.replace(/;?hw=[^;]*/, '')
}

/**
 * Puts back the hardware layout each keyboard had before Orca, keeping keyboards the user added
 * since (those return to Automatic). Null means AppleKeyboards should be unset again.
 */
export function withOriginalHardwareLayouts(
  current: string[] | null,
  original: string[] | null
): string[] | null {
  const before = new Map(
    (original ?? [AUTOMATIC_DEFAULT_KEYBOARD]).map((entry) => [withoutHardwareLayout(entry), entry])
  )
  const restored = withHardwareLayout(current, 'Automatic').map(
    (entry) => before.get(withoutHardwareLayout(entry)) ?? entry
  )
  const untouchedDefault =
    original === null && restored.every((entry) => entry === AUTOMATIC_DEFAULT_KEYBOARD)
  return untouchedDefault ? null : restored
}

async function simctl(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runProcess({ program: 'xcrun', args, timeoutMs: SIMCTL_TIMEOUT_MS })
}

async function simctlOrThrow(args: string[]): Promise<string> {
  const result = await simctl(args)
  if (result.code !== 0) {
    throw new Error(`xcrun ${args.join(' ')} exited with code ${result.code}`)
  }
  return result.stdout
}

/** Null when AppleKeyboards is unset (iOS then uses its default keyboard); throws when it cannot be read. */
async function readSimulatorKeyboards(udid: string): Promise<string[] | null> {
  const result = await simctl(['simctl', 'spawn', udid, 'defaults', 'read', '-g', 'AppleKeyboards'])
  if (result.code === 0) {
    return parseAppleKeyboardsDefaults(result.stdout)
  }
  if (/Could not find key|does not exist/.test(result.stderr + result.stdout)) {
    return null
  }
  throw new Error(`Could not read the simulator keyboards (exit ${result.code})`)
}

async function writeSimulatorKeyboards(udid: string, entries: string[] | null): Promise<void> {
  const write = entries
    ? ['defaults', 'write', '-g', 'AppleKeyboards', '-array', ...entries]
    : ['defaults', 'delete', '-g', 'AppleKeyboards']
  await simctlOrThrow(['simctl', 'spawn', udid, ...write])
  await simctlOrThrow(['simctl', 'spawn', udid, 'notifyutil', '-p', KEYBOARDS_CHANGED_NOTIFICATION])
}

// A device's runtime never changes, so each device reads its runtime's layout list once.
const iosLayoutsByDevice = new Map<string, Promise<IosKeyboardLayouts>>()

function readIosKeyboardLayouts(udid: string): Promise<IosKeyboardLayouts> {
  let layouts = iosLayoutsByDevice.get(udid)
  if (!layouts) {
    layouts = simctlOrThrow(['simctl', 'getenv', udid, 'SIMULATOR_ROOT']).then(
      parseIosKeyboardLayouts
    )
    iosLayoutsByDevice.set(udid, layouts)
    // Only a parsed list is worth keeping; a transient failure retries on the next sync.
    layouts.catch(() => iosLayoutsByDevice.delete(udid))
  }
  return layouts
}

async function parseIosKeyboardLayouts(runtimeRoot: string): Promise<IosKeyboardLayouts> {
  const result = await runProcess({
    program: '/usr/bin/plutil',
    args: ['-convert', 'json', '-o', '-', `${runtimeRoot.trim()}/${IOS_LAYOUTS_PLIST}`],
    timeoutMs: SIMCTL_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new Error(`plutil exited with code ${result.code}`)
  }
  const layouts: unknown = JSON.parse(result.stdout)
  if (!layouts || typeof layouts !== 'object') {
    throw new Error('USBKeyboardLayouts.plist is not a dictionary')
  }
  return { ...layouts }
}

type DeviceSyncState = {
  /** AppleKeyboards before Orca first looked at it; null when it was unset. */
  original: string[] | null
  macLayoutId: string
  synced: boolean
  rewritten: boolean
  /** The key that types "v" in the synced layout, for Cmd+V (it is "." on Dvorak). */
  pasteKeyCode: string
}

/**
 * Keeps each simulator's hardware keyboard layout on the Mac's current layout, as Simulator.app's
 * "Use the Same Keyboard Language as macOS" does, so physical key usages type what the Mac key shows.
 */
export class SimulatorHardwareKeyboardSync {
  private readonly devices = new Map<string, DeviceSyncState>()
  // Each sync reads the Mac layout after the one before it settles, so a switch mid-sync is not lost.
  private readonly syncQueues = new Map<string, Promise<void>>()
  // A guest prefs read costs ~0.3 s, so each helper session reads AppleKeyboards once and tracks its own writes.
  private readonly keyboards = new Map<string, string[] | null>()

  private async readKeyboards(udid: string): Promise<string[] | null> {
    const cached = this.keyboards.get(udid)
    if (cached !== undefined) {
      return cached
    }
    const entries = await readSimulatorKeyboards(udid)
    this.keyboards.set(udid, entries)
    return entries
  }

  /** Whether US key usages type what they name, which `orca emulator type` needs before sending keys. */
  isUSHardwareKeyboard(udid: string): Promise<boolean> {
    return this.readKeyboards(udid).then(isUSHardwareKeyboard, () => false)
  }

  /** Resolves true when the simulator now uses the Mac's layout, so the pane can send physical keys. */
  sync(udid: string): Promise<boolean> {
    return runKeyedSerializedOperation(this.syncQueues, udid, () => this.syncNow(udid)).catch(
      () => false
    )
  }

  async pasteKeyCode(udid: string): Promise<string> {
    await getKeyedSerializedQueueTail(this.syncQueues, udid)
    return this.devices.get(udid)?.pasteKeyCode ?? 'KeyV'
  }

  private async syncNow(udid: string): Promise<boolean> {
    const macLayoutId = (await readCurrentKeyboardLayoutSourceId()).trim()
    const known = this.devices.get(udid)
    if (known?.macLayoutId === macLayoutId) {
      return known.synced
    }
    const [iosLayouts, current] = await Promise.all([
      readIosKeyboardLayouts(udid),
      this.readKeyboards(udid)
    ])
    const hardwareLayout = iosHardwareLayoutForMacLayout(macLayoutId, iosLayouts)
    // Recorded before any write: one that lands but whose notify fails still needs restoring.
    const state: DeviceSyncState = known ?? {
      original: current,
      macLayoutId: '',
      synced: false,
      rewritten: false,
      pasteKeyCode: 'KeyV'
    }
    this.devices.set(udid, state)
    // A Mac layout iOS lacks leaves the simulator on the user's own setting.
    const next = hardwareLayout ? withHardwareLayout(current, hardwareLayout) : state.original
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      state.rewritten = true
      this.keyboards.delete(udid)
      await writeSimulatorKeyboards(udid, next)
      this.keyboards.set(udid, next)
    }
    state.synced = hardwareLayout !== null
    state.pasteKeyCode = state.synced ? await macKeyCodeTypingV(macLayoutId) : 'KeyV'
    state.macLayoutId = macLayoutId
    return state.synced
  }

  async restore(udid: string): Promise<void> {
    await getKeyedSerializedQueueTail(this.syncQueues, udid)
    this.keyboards.delete(udid)
    const known = this.devices.get(udid)
    if (!known) {
      return
    }
    if (known.rewritten) {
      // A shut-down simulator rejects these; keep the original so the next attach still restores it.
      const restored = await readSimulatorKeyboards(udid)
        .then((current) => {
          const next = withOriginalHardwareLayouts(current, known.original)
          return JSON.stringify(next) === JSON.stringify(current)
            ? undefined
            : writeSimulatorKeyboards(udid, next)
        })
        .then(
          () => true,
          () => false
        )
      if (!restored) {
        return
      }
    }
    this.devices.delete(udid)
  }
}

async function macKeyCodeTypingV(macLayoutId: string): Promise<string> {
  const snapshot = await readMacKeyboardLayoutSnapshot()
  if (snapshot?.layoutSourceId !== macLayoutId) {
    return 'KeyV'
  }
  const entry = Object.entries(snapshot.keyCharacters).find(
    ([, characters]) => characters.unmodified === 'v'
  )
  return entry?.[0] ?? 'KeyV'
}
