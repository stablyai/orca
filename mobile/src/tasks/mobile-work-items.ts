// Why: these limits must match desktop cache/fetch behavior, but mobile cannot
// import root shared modules at runtime because Metro resolves from mobile/.
export const PER_REPO_FETCH_LIMIT = 36
export const CROSS_REPO_DISPLAY_LIMIT = 100
