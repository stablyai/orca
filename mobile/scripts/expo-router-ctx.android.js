// Expo Router's built-in `_ctx.android.js` uses `.*(?:\.ios|\.web)?\.[tj]sx?$`, which matches
// `.web.tsx` and `.ios.tsx` instead of excluding them, pulling every Route A web page screen
// into the native Android bundle only for `getRoutesCore` to discard them at runtime.
export const ctx = require.context(
  '../app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)|(?:.*\.(?:ios|web))))\.[tj]sx?$).*\.[tj]sx?$/,
  process.env.EXPO_ROUTER_IMPORT_MODE
)
