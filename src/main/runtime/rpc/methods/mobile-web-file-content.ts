import { MOBILE_WEB_FILE_CONTENT_MAX_BYTES } from '../../../../shared/mobile-web/file-operation-contract'

export function boundMobileWebFileContent(
  result: Record<string, unknown>
): Record<string, unknown> {
  if (typeof result.content !== 'string') {
    throw new Error('Invalid file content')
  }
  const bytes = Buffer.from(result.content, 'utf8')
  if (!Number.isSafeInteger(result.byteLength) || (result.byteLength as number) < bytes.length) {
    throw new Error('Invalid file byte length')
  }
  let content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    bytes.subarray(0, MOBILE_WEB_FILE_CONTENT_MAX_BYTES),
    {
      stream: true
    }
  )
  let low = 0
  let high = content.length
  // JSON escaping can exceed the bridge ceiling even when decoded text fits.
  while (low < high) {
    const end = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(content.slice(0, end)), 'utf8') <= 480 * 1024) {
      low = end
    } else {
      high = end - 1
    }
  }
  if (low < content.length && /[\uD800-\uDBFF]/.test(content[low - 1] ?? '')) {
    low -= 1
  }
  content = content.slice(0, low)
  return { ...result, content, truncated: result.truncated === true || content !== result.content }
}
