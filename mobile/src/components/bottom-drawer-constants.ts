// Why: standalone module so pure consumers can read the timing without
// importing BottomDrawer's native deps, which don't load under the test runner.
export const BOTTOM_DRAWER_HIDE_DURATION_MS = 150
