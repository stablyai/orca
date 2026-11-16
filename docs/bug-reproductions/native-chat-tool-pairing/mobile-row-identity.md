# Keep mobile tool details with their row

Opening a tool result, then removing an earlier command, could move the expanded detail to a different command. Mobile used the row position as its React identity.

Mobile now shares desktop's provider-ID and duplicate-occurrence identity. Named standalone results use a separate result-ID namespace, preserving their detail across copied history refreshes without transferring it to a command. Anonymous rows use a weak object identity, avoiding large input serialization and resetting detail when a replacement cannot be identified safely. Desktop identities and matching rules are preserved.

Four mobile component regressions cover prefix removal, reordering, changed input/results, duplicate IDs, orphan replacement and copied named-result refreshes. Two shared identity tests cover named duplicates and avoiding serialization of anonymous inputs. The current-main integration check also passed all 13 tests across the identity, result-availability and paging suites, including both host-scope variants of copied journal refreshes. The earlier rendered receipt below captures the command-row fix before this additional result-row guard.

The rendered browser check uses production React Native Web components, shipped bundle options and the shell CSP. Both unique-ID and duplicate-ID scenarios reproduce the incorrect expansion before the fix and retain the correct detail after removal and reordering. It records source and output hashes in [the receipt](./mobile-row-identity-validation.json). This is mobile component proof, not a native-phone or SSH latency test.

| Before                                                                                                                | After                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Different command becomes expanded](https://github.com/user-attachments/assets/966c9d20-650e-4651-96da-1e51f121b95c) | [Selected result remains expanded](https://github.com/user-attachments/assets/358669cd-7a49-4750-a76b-9897d3eb6323) |

Missing historical IDs cannot be recovered. Removing or reordering earlier occurrences with the same provider ID remains ambiguous. Replacement anonymous rows close their detail; results stay visible. Weak identities do not retain removed blocks. No public wire fields or styling changed.
