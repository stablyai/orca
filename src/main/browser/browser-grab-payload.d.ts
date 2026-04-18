import type { BrowserGrabPayload } from '../../shared/browser-grab-types';
/**
 * Re-validate and clamp all string, array, and budget fields in a grab payload
 * before forwarding to the renderer. This is the main-side safety net: even if
 * the guest runtime is compromised, the payload that reaches renderer chrome
 * respects the documented budgets.
 *
 * Returns null if the payload is structurally invalid (missing required fields).
 */
export declare function clampGrabPayload(raw: unknown): BrowserGrabPayload | null;
