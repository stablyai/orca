/**
 * The grant that names the binary screencast lane, and the one rule that reads it.
 *
 * One camelCase token because the host contract's grant pattern admits exactly that or a
 * `native.<domain>.<action>` verb: `browser.screencast` and `native.screencast` are both refused
 * there, and this is not a verb — nothing is requested and answered, the shell simply encodes
 * frames a stream is already producing.
 *
 * It exists as a grant rather than as a property of the stream because it is the only thing that
 * tells a page a shell can carry those frames at all. An app built before C6.1 parses a manifest
 * naming it, finds nothing behind it, and leaves the route native rather than mounting a pane that
 * would subscribe and wait for frames that cannot come.
 */
export const BRIDGE_SCREENCAST_BINARY_GRANT = 'screencastBinary'

/**
 * Three outcomes rather than a boolean, because two of them are the same answer for different
 * reasons and only one of them is worth reporting.
 */
export type BridgeBinaryLaneVerdict = 'serve' | 'not-asked' | 'ungranted'

/**
 * Whether this session's subscribe gets the binary lane.
 *
 * Both halves, and neither implies the other. The page asks, because encoding costs the shell a
 * base64 pass over every frame and a page with no listener would pay for frames it drops. The
 * session was granted it, because grants are per route: without this any route's page could ask for
 * a lane its route never declared, which is the hole per-route grants exist to close.
 *
 * Ungranted is not a refusal on the wire. The subscription proceeds and its JSON events cross as
 * they always have — the same silence every other grant gives at the call site, and a state a page
 * that reads its own `init.grants.native` never reaches. It is named apart from `not-asked` so the
 * host can say so locally: nothing crosses back, so without a diagnostic a page that did ask gets
 * JSON for the life of the document with no side able to say why.
 */
export function bridgeBinaryLaneVerdict(args: {
  wantsBinary: boolean | undefined
  /** The session's resolved list: what its route declared, narrowed to what this shell implements. */
  granted: readonly string[]
}): BridgeBinaryLaneVerdict {
  if (args.wantsBinary !== true) {
    return 'not-asked'
  }
  return args.granted.includes(BRIDGE_SCREENCAST_BINARY_GRANT) ? 'serve' : 'ungranted'
}
