// The body lives under src/ so its `.web.tsx` sibling has a plain stem: expo-router 55 reads a
// file's platform from the first dot of its stripped name, and `[...page].web.tsx` here would
// register a second route instead of overriding this one. See catch-all-page-route.tsx.
export { default } from '../../../src/mobile-web-shell/catch-all-page-route'
