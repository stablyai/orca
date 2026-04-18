import type { BrowserGrabRect, BrowserGrabScreenshot } from '../../shared/browser-grab-types';
/**
 * Capture a screenshot of the guest surface and optionally crop it to
 * the given CSS-pixel rect.
 */
export declare function captureSelectionScreenshot(rect: BrowserGrabRect, guest: Electron.WebContents): Promise<BrowserGrabScreenshot | null>;
