// Encoded length (base64 of gzipped JSON), about 3-5 MB of JSON; writers trim or skip larger values.
// Lives here, not in the store module, so a page can check it without importing the store.
export const DEVICE_STORE_MAX_VALUE_LENGTH = 512 * 1024
