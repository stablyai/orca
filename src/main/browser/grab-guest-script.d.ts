type GuestScriptAction = 'arm' | 'awaitClick' | 'finalize' | 'extractHover' | 'teardown';
/**
 * Build a self-contained JS script for the given grab lifecycle action.
 *
 * - `arm`: install the shadow-root overlay, hover listeners, and extraction logic
 * - `awaitClick`: return a Promise that resolves with the payload when the user clicks
 * - `finalize`: extract the payload for the currently hovered element and return it
 * - `extractHover`: extract the payload for the currently hovered element WITHOUT cleanup
 * - `teardown`: remove the overlay and all listeners
 */
export declare function buildGuestOverlayScript(action: GuestScriptAction): string;
export {};
