export const MAX_BYTES = 64 * 1024 * 1024 // 64 MB — generous but bounded so a user can't point at a multi-GB file and OOM the renderer when it builds a Blob URL.
export const MAX_MANIFEST_BYTES = 64 * 1024 // pet.json is tiny by spec; cap to defend against a malicious bundle stuffing megabytes into the manifest.
