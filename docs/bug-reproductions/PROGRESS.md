# Bug reproduction progress log

Living tracker for the orchestration pass. **Index of results:** [README.md](./README.md).  
**Windows deferred:** [WINDOWS-ONLY.md](./WINDOWS-ONLY.md).

| Field | Value |
|-------|-------|
| Started | 2026-07-15 |
| Updated | 2026-07-16 |
| Host | macOS · production Orca 1.4.143 |
| Worktree | `cooked-PRs` |
| Constraint | No live `orca file open` of missing paths (ghost ENOENT tabs) |
| GitHub labels | **`has_repro`** · **`cannot_repro`** |

---

## Final snapshot (Pass 3 complete)

| Bucket | Count |
|--------|------:|
| **`has_repro`** (open issues) | **~46** |
| **`cannot_repro`** | **4** — #8440, #8749, #8838, #8943 |
| **PARTIAL** (no label) | **2** — #8539, #8970 |
| **DEFERRED Windows** | #8813 + [WINDOWS-ONLY.md](./WINDOWS-ONLY.md) |
| **Issue writeups** | **54** (`docs/bug-reproductions/<n>.md`) |

Filters:
- [has_repro](https://github.com/stablyai/orca/issues?q=is%3Aissue+label%3Ahas_repro)
- [cannot_repro](https://github.com/stablyai/orca/issues?q=is%3Aissue+label%3Acannot_repro)

---

## Session log

### Pass 1 — 2026-07-15
Initial scan; first 14 reproductions; #8838 cannot_repro; #8844 ghost-tab soft-open.

### Pass 2 — 2026-07-15
Batches A+B (+10 GHE/pet/undici/serve/Linear/RM/history).

### Pass 3 — 2026-07-16
- Label rename: `cannot_reproduce` → **`cannot_repro`**.
- **Batch C complete** (7 REPRO + 2 NOT): 8797, 8378, 8715, 8881, 8878, 8478, 8593 + cannot 8749, 8943.
- **Batch D complete** (8 REPRO + 1 PARTIAL + 1 DEFERRED): 8450, 8742, 8299, 8733, 8399, 8986, 8372, 8974 + partial 8539 + Windows 8813.
- **Batch E complete** (8 REPRO + 1 NOT): 8482, 8752, 8726, 8934, 8335, 8758, 8541, 8622 + cannot 8440.
- Fixed flaky tests: 8378, 8715, 8881.

### Unit tests
All batch C/D/E repro suites verified green (e.g. 31 + 17 + 29 tests in final re-runs).

---

## Next agent checklist

1. Read this file + README.
2. Prefer open bugs **without** `has_repro` / `cannot_repro` and without a doc.
3. Windows → WINDOWS-ONLY.md only.
4. Write `docs/bug-reproductions/<n>.md` + vitest under `src/**`.
5. Apply `has_repro` or `cannot_repro`.
6. Never `orca file open` missing paths.
