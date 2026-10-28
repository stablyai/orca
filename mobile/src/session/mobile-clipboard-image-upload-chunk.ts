// Keep the shared byte budget free of upload RPC imports; media verbs also need it in page bundles.
export const MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
