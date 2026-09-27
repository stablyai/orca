import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSource } from './mobile-session-route-source-family.test-support'

const sendActionsSource = readMobileSessionRouteSource(
  './use-mobile-session-terminal-send-actions.ts'
)

const BINDING_CALL = 'useTerminalTextFieldSubmitBinding('

/** The handler each field hands its submit binding, in source order. */
function readBoundSubmitNames(source: string): string[] {
  const names: string[] = []
  let at = source.indexOf(BINDING_CALL)
  while (at >= 0) {
    const args = source.slice(at + BINDING_CALL.length, source.indexOf(')', at))
    const handler = args.split(',')[1]?.trim()
    if (handler) {
      names.push(handler)
    }
    at = source.indexOf(BINDING_CALL, at + 1)
  }
  return names
}

/**
 * The rule: a handler bound through `useTerminalTextFieldSubmitBinding` must not be frozen on an
 * empty dependency list.
 *
 * `handleSend` is a per-render function whose guard reads `client`, `activeHandle` and `canSend`,
 * all absent on the first render, so a submit memoized on `[]` is one closure for the life of the
 * component and the field's line-break submit can never pass that guard. The field's own
 * `onSubmitEditing` prop keeps working, which is what hid it.
 *
 * Why a source rule and not a render: every check that mounts its own submit writes the identity
 * under test itself, so the render rig's probe route could catch neither the defect nor the fix.
 * `terminal-field-submit-binding-send.test.tsx` reads the behaviour instead and catches spellings
 * this cannot; this one is the cheap guard beside it.
 */
describe('the submit handlers the terminal fields bind', () => {
  it('names one handler per bound field', () => {
    expect(readBoundSubmitNames(sendActionsSource)).toEqual([
      'submitLiveInput',
      'submitBufferedDraft'
    ])
  })

  it('freezes none of them on an empty dependency list', () => {
    for (const name of readBoundSubmitNames(sendActionsSource)) {
      const declaredAt = sendActionsSource.indexOf(`const ${name} = `)
      expect(declaredAt).toBeGreaterThanOrEqual(0)
      const boundAt = sendActionsSource.indexOf(`${BINDING_CALL}`, declaredAt)
      expect(boundAt).toBeGreaterThan(declaredAt)
      expect(sendActionsSource.slice(declaredAt, boundAt)).not.toContain('}, [])')
    }
  })

  // The other half of the rule: a handler that is memoized must name what it reads, so the closure
  // moves when the send guard's inputs do.
  it('gives the live input submit the dependencies its closure reads', () => {
    const declaredAt = sendActionsSource.indexOf('const submitLiveInput = ')
    const boundAt = sendActionsSource.indexOf(BINDING_CALL, declaredAt)
    const slice = sendActionsSource.slice(declaredAt, boundAt)
    expect(slice).toContain('handleLiveInputSubmit')
    expect(slice).toContain('activeSessionTab')
  })
})
