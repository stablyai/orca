export const BROWSER_SCREENSHOT_MAX_DIMENSION_PX = 32_768
export const BROWSER_SCREENSHOT_MAX_EFFECTIVE_PIXELS = 32 * 1024 * 1024
export const BROWSER_SCREENSHOT_MAX_ENCODED_BYTES = 32 * 1024 * 1024
export const BROWSER_SCREENSHOT_MAX_CONCURRENT_CAPTURES = 2
export const BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR =
  'Screenshot exceeds the browser automation memory limit'
export const BROWSER_SCREENSHOT_BUSY_ERROR = 'Too many screenshot requests are already running'

export function assertBrowserScreenshotGeometry(width: number, height: number, scale = 1): void {
  const effectiveWidth = width * scale
  const effectiveHeight = height * scale
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(scale) ||
    width <= 0 ||
    height <= 0 ||
    scale <= 0 ||
    effectiveWidth > BROWSER_SCREENSHOT_MAX_DIMENSION_PX ||
    effectiveHeight > BROWSER_SCREENSHOT_MAX_DIMENSION_PX ||
    effectiveWidth * effectiveHeight > BROWSER_SCREENSHOT_MAX_EFFECTIVE_PIXELS
  ) {
    throw new Error(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
  }
}

export function assertBrowserScreenshotEncodedBytes(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > BROWSER_SCREENSHOT_MAX_ENCODED_BYTES) {
    throw new Error(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
  }
}

export function assertBrowserScreenshotBase64(data: string): void {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const decodedBytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding)
  assertBrowserScreenshotEncodedBytes(decodedBytes)
}
