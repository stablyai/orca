/**
 * The base64 one append of the clipboard-image upload carries.
 *
 * A leaf of its own because two unrelated closures need the number and only one of them wants the
 * upload path: the bridge's media verbs hold a chunk read to exactly this budget, and importing it
 * from the upload module would pull that module's RPC operations into every page's closure.
 */
export const MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
