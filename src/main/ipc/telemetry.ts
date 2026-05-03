// IPC surface for the telemetry transport. Two handlers, both renderer-
// facing: one pipe (`telemetry:track`) and one consent-mutation
// (`telemetry:setOptIn`). Every track call from the renderer lands here,
// and from here funnels into the same `track()` the main-originated events
// go through — the validator is the single enforcement point, not this
// file.
//
// Threat model: the renderer renders attacker-controllable content (agent
// output, MCP responses, file contents, markdown, diff views). An
// XSS-equivalent rendering bug in any of those surfaces gives an attacker
// the ability to invoke `window.api.telemetry*` at will. Both handlers
// below are designed to fail closed under that model:
//
//   - Strict main-side type narrows. TypeScript types do not survive IPC
//     serialization; the renderer can pass anything across the wire, so we
//     narrow at the boundary. Non-string `name` or non-object `props` on
//     `track` → drop silently. Non-boolean `optedIn` on `setOptIn` → drop.
//   - Consent-mutation rate limit. A real user flips the Privacy pane
//     toggle a handful of times at most; beyond 5 per session it is either
//     a UI bug or a compromised renderer. Drop silently past the cap.

import { ipcMain } from 'electron'
import { consumeConsentMutationToken } from '../telemetry/burst-cap'
import { setOptIn, track } from '../telemetry/client'
import type { EventName, EventProps } from '../../shared/telemetry-events'

export function registerTelemetryHandlers(): void {
  ipcMain.handle(
    'telemetry:track',
    (_event, name: unknown, props: unknown): void => {
      // Strict input typing: non-string names are dropped at the boundary
      // before the validator even sees them. The validator would also drop
      // (unknown event name), but the main-side narrow keeps the attack
      // surface minimal — a flood of bogus payloads does not exercise the
      // Zod parser for no reason.
      if (typeof name !== 'string') {
        return
      }
      // `props` may legitimately be omitted; treat `undefined`/`null` as an
      // empty object before the validator. Anything else non-object (e.g.
      // a string, a number) is a boundary violation.
      if (props !== null && props !== undefined && typeof props !== 'object') {
        return
      }
      // The casts to `EventName` / `EventProps<EventName>` here are
      // pass-through only — this file does NOT pretend the renderer's
      // name/props are type-safe. The validator inside `track()` is the
      // single enforcement point at runtime; these casts only feed the
      // typed channel that the validator will re-check.
      track(
        name as EventName,
        (props ?? {}) as EventProps<EventName>
      )
    }
  )

  ipcMain.handle('telemetry:setOptIn', (_event, optedIn: unknown): void => {
    // Strict input typing — renderer can pass anything over IPC.
    if (typeof optedIn !== 'boolean') {
      return
    }
    // Consent-mutation bucket: ≤5 per session. See `burst-cap.ts`. Does not
    // apply to main-originated consent mutations that bypass IPC (none
    // today; this is future-proofing rather than a current code path).
    if (!consumeConsentMutationToken()) {
      return
    }
    setOptIn('settings', optedIn)
  })
}
