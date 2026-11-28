// Expo Router's built-in `_ctx.ios.js` uses `.*(?:\.android|\.web)?\.[tj]sx?$`, which matches
// `.web.tsx` and `.android.tsx` instead of excluding them, pulling every Route A web page screen
// into the native iOS bundle only for `getRoutesCore` to discard them at runtime.
export const ctx = require.context(
  '../app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)|(?:.*\.(?:android|web))))\.[tj]sx?$).*\.[tj]sx?$/,
  process.env.EXPO_ROUTER_IMPORT_MODE
)
