// `nativeEvent: object` so React Native's own TextInputChangeEvent stays assignable: the patch
// that adds `isComposing` to the iOS metrics is not reflected in React Native's shipped types.
type ImeChangeEvent = { readonly nativeEvent: object }

export type ImeGuardedSubmitProps = {
  readonly onChange: (event: ImeChangeEvent) => void
  readonly onSubmitEditing: (event?: ImeChangeEvent) => void
}

// The carry models the in-flight IME gesture, so it is module state rather than per-field — but it
// records WHICH field armed it (React Native's view tag, on every textInputMetrics payload), so a
// confirmation in one field can never swallow a different field's Return.
const carry: { composing: boolean; pending: object | null; target: number | undefined } = {
  composing: false,
  pending: null,
  target: undefined
}

/**
 * Why: iOS confirms a marked composition by unmarking the text and *then* firing
 * `onSubmitEditing` for that same key press — React Native's
 * `textInputShouldSubmitOnReturn` never inspects `markedTextRange`. An
 * "is composing" boolean cannot see it, because composition has already ended by
 * the time submit arrives (the mobile analogue of the renderer's Mode B). So the
 * confirming change hands ownership of the *next* submit to the IME.
 *
 * Ownership expires on the next frame, never on an event count: a user who
 * deliberately presses Return after confirming produces no intervening change
 * event, so anything counted would eat that Return. Android is excluded until a
 * device trace exists — its marking IMEs may deliver a wanted Return in the same
 * turn, and `isComposing` is absent there outside the terminal input anyway.
 */
export function noteImeCompositionChange(
  platform: string,
  isComposing: boolean | undefined,
  target?: number
): void {
  const composing = isComposing === true
  const confirmed = carry.composing && !composing
  carry.composing = composing
  if (!confirmed || platform !== 'ios') {
    carry.pending = null
    return
  }
  const token = {}
  carry.pending = token
  carry.target = target
  requestAnimationFrame(() => {
    if (carry.pending === token) {
      carry.pending = null
    }
  })
}

/** True when this submit belongs to an IME confirmation gesture rather than the user. */
export function imeOwnsSubmit(target?: number): boolean {
  if (!carry.pending || carry.target !== target) {
    return false
  }
  carry.pending = null
  return true
}

type ImeChangeMetrics = { isComposing?: boolean; target?: number }

/** Spread onto any single-line `TextInput` whose Return commits something. */
export function imeGuardedSubmitProps(platform: string, submit: () => void): ImeGuardedSubmitProps {
  return {
    onChange: (event) => {
      const metrics = event.nativeEvent as ImeChangeMetrics
      noteImeCompositionChange(platform, metrics.isComposing, metrics.target)
    },
    onSubmitEditing: (event) => {
      if (!imeOwnsSubmit((event?.nativeEvent as ImeChangeMetrics | undefined)?.target)) {
        submit()
      }
    }
  }
}
