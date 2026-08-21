# Shell wrapper snapshots

Generated test fixtures. **Do not edit by hand.**

Each `.txt` here is the byte-exact content of one shell startup file Orca writes
into a pane's wrapper `ZDOTDIR`, captured per transport:

|            |                   |
| :--------- | :---------------- |
| `local-*`  | local PTY         |
| `daemon-*` | daemon / SSH host |
| `relay-*`  | relay overlay     |

Owned by [`../../shell-wrapper-generated-file-snapshot.test.ts`](../../shell-wrapper-generated-file-snapshot.test.ts),
which drives the real wrapper entry points, reads the files back off disk and
compares them here. The temp wrapper root is normalized to `<WRAPPER_ROOT>` —
the only path-dependent bytes in the output.

## Why these exist

The three zsh generators were once copy-pasted and drifted, so a fix landed in
one transport and silently missed the other two. These pin all three at once, so
drift shows up as a reviewable shell diff instead of hiding in a TypeScript
template literal.

## Regenerating

Run the test and review the resulting diff:

```sh
npx vitest run --config config/vitest.config.ts src/main/shell-wrapper-generated-file-snapshot.test.ts
```

⚠️ `toMatchFileSnapshot` **rewrites these files on mismatch when run locally** —
only CI fails. So a passing local run proves nothing on its own: always
`git diff` this directory afterwards, and treat any change as a real behavior
change to what users' shells execute until you have explained it.
