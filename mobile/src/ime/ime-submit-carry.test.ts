import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { imeGuardedSubmitProps, noteImeCompositionChange } from './ime-submit-carry'

// Captured on a physical iPhone 13 Pro Max, iOS 26.5.2, system Japanese Kana keyboard
// (lane-ios/metro.log, IME7427_NATIVE_EVENT eventCount 5-10). Five marked events, then the
// confirmation unmarks the same text — and iOS fires onSubmitEditing right after it.
const RECORDED_IOS_DEVICE_FLICK_VOWELS: readonly (boolean | undefined)[] = [
  true,
  true,
  true,
  true,
  true,
  false
]

// The paired ASCII control from the same capture arm: never marked.
const ORDINARY_ASCII: readonly (boolean | undefined)[] = [false, false, false]

// iOS Korean 2-set never marks — all 12 events in the retained #11235 trace are isComposing false.
const RECORDED_IOS_KOREAN: readonly (boolean | undefined)[] = Array.from(
  { length: 12 },
  () => false
)

const frames: Array<() => void> = []

function flushFrame(): void {
  for (const callback of frames.splice(0)) {
    callback()
  }
}

// `target` is React Native's view tag: every textInputMetrics payload carries it, on onChange and
// onSubmitEditing alike, so it identifies which field emitted an event. The device capture recorded
// target 3760 throughout.
function createField(
  platform: string,
  target = 3760
): {
  readonly submits: number[]
  readonly type: (trace: readonly (boolean | undefined)[]) => void
  readonly pressReturn: () => void
} {
  const submits: number[] = []
  const props = imeGuardedSubmitProps(platform, () => submits.push(submits.length))
  return {
    submits,
    type: (trace) => {
      for (const isComposing of trace) {
        props.onChange({ nativeEvent: { isComposing, target } })
      }
    },
    pressReturn: () => props.onSubmitEditing({ nativeEvent: { target } })
  }
}

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.push(callback)
    return frames.length
  })
  noteImeCompositionChange('android', true)
  noteImeCompositionChange('android', false)
})

describe('ime submit carry', () => {
  it('drops the submit iOS fires for the recorded device confirmation', () => {
    const field = createField('ios')
    field.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    field.pressReturn()
    expect(field.submits).toEqual([])
  })

  it('submits a deliberate Return taken one frame after that confirmation', () => {
    const field = createField('ios')
    field.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    flushFrame()
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('submits the paired ASCII control on its genuine Return', () => {
    const field = createField('ios')
    field.type(ORDINARY_ASCII)
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('keeps the unmarking iOS Korean keyboard submitting on its confirming Return', () => {
    const field = createField('ios')
    field.type(RECORDED_IOS_KOREAN)
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('owns only the first submit, so a repeated Return still reaches the action', () => {
    const field = createField('ios')
    field.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    field.pressReturn()
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('releases the carry when the confirmation is followed by another keystroke', () => {
    const field = createField('ios')
    field.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    field.type([false])
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('stays inert on Android, whose editor-action behaviour has no device trace', () => {
    const field = createField('android')
    field.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })

  it('lets a second field submit inside the frame a first field armed', () => {
    const composing = createField('ios', 3760)
    const other = createField('ios', 4210)
    composing.type(RECORDED_IOS_DEVICE_FLICK_VOWELS)
    other.pressReturn()
    expect(other.submits).toEqual([0])
  })

  it('never arms without a marked event, so unpatched hosts are unchanged', () => {
    const field = createField('ios')
    field.type([undefined, undefined])
    field.pressReturn()
    expect(field.submits).toEqual([0])
  })
})

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

describe('irreversible mobile Return surfaces route through the carry', () => {
  it.each([
    ['src/session/terminal-session-input-bar.tsx', 'handleSend'],
    ['app/h/[hostId]/tasks.tsx', '() => void connectLinearAccount()'],
    ['src/browser/MobileBrowserPane.tsx', '() => void sendKeyboardText()'],
    ['src/source-control/MobileSourceControlContent.tsx', 'primaryAction.onPress']
  ])('%s guards %s', (relativePath, action) => {
    const source = sourceOf(relativePath)
    expect(source).toContain(`{...imeGuardedSubmitProps(Platform.OS, ${action})}`)
    expect(source).not.toContain(`onSubmitEditing={${action}}`)
  })

  it('routes the terminal live input submit through the same carry', () => {
    const commit = sourceOf('src/terminal/use-terminal-live-input-commit.ts')
    expect(commit).toContain('imeOwnsSubmit((event?.nativeEvent as { target?: number }')
    expect(commit).toContain(
      'noteImeCompositionChange(platform, nativeEvent.isComposing, nativeEvent.target)'
    )
    expect(sourceOf('app/h/[hostId]/session/[worktreeId].tsx')).toContain('platform: Platform.OS')
  })
})
