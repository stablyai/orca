/**
 * Whether this build can be handed screencast frames over the lane it would ask for.
 *
 * Native: the socket carries the binary frame itself and this app is both halves of that path, so
 * there is nothing to negotiate and nothing that can be missing. The `.web.ts` sibling is where the
 * question has an answer other than yes, because there the frames come through a shell that may be
 * older than the page and have no encoder behind the request.
 */
export function useBrowserBinaryScreencastGrant(): boolean {
  return true
}
