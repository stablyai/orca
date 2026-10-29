# Unit test input ownership

Unit selection remains advisory. Every PR still executes the full unit inventory.

`config/scripts/ci-unit-input-ownership.json` records reviewed indirect repository inputs. A record covers the entire local source closure reachable from its `file`, including type imports. It does not remove ordinary import edges. Other callers of an indirect reader retain their own conservative fallback.

- `inputs`: exact repository paths or directory prefixes ending in `/`. Directory ownership includes new files. Unknown, deleted, renamed and global inputs still select the full suite.
- `emptyEnv`: optional external input overrides that must be absent or empty for the declaration to apply.
- `sourceClosureSha256`: `unitInputSourceDigest` of the sorted path/content entries in the local import closure. Unresolved or ambiguous package-directory imports cannot qualify.
- `contextSha256`: fingerprint of locked dependencies and the selection policy and unit runner/setup source closures. Dependency, policy or shared-runtime changes invalidate earlier review.
- `reason`: what was reviewed and why these inputs are sufficient.

The transcript replay record owns its captured-fixture directories and rejects optional external transcript/addon overrides. The compiler census owns all source, configuration and test directories. Reviewed URL/data projections have no indirect repository inputs.

A missing, malformed, duplicated or stale record keeps the conservative behavior. Before updating fingerprints, review the changed source closure, dependency/runtime context and any indirect reads again. Regenerating a digest does not establish ownership. The graph exposes `ownershipContextSha256`; source digests use `unitInputSourceDigest` from `ci-unit-input-ownership.mjs`.

For an eligible plan, `ci-shards/unit-selection.json` lists `checkedInputOwners`. Full successful and failing references, input addition/deletion/rename cases and hosted timing evidence are required before changing execution policy. Omitted worker time overlaps across processes and must not be reported as runner savings.
