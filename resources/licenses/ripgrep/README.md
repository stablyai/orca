# Bundled ripgrep notices

Orca ships prebuilt ripgrep (`rg`) binaries from `@vscode/ripgrep-universal` under
`Resources/ripgrep/` and in the standalone runtime's `ripgrep/` directory,
for local, WSL, and SSH-remote search.

- ripgrep: dual-licensed MIT (`LICENSE-MIT`) or Unlicense (`UNLICENSE`).
- PCRE2, statically linked into ripgrep's `--pcre2` support: BSD (`PCRE2-LICENCE.md`).
- musl libc, statically linked into the Linux builds: MIT (`MUSL-COPYRIGHT`).
- jemalloc, ripgrep's allocator on the musl builds: BSD-2-Clause (`JEMALLOC-COPYING`).
- LLVM libunwind, statically linked into the Linux builds by Rust's musl target:
  Apache-2.0 WITH LLVM-exception (`LLVM-LIBUNWIND-LICENSE.TXT`).
- PCRE2's sljit compiler: BSD-2-Clause (`SLJIT-LICENSE`).
- Rust dependencies: `RUST-CRATE-NOTICES.txt`, sourced from the ripgrep 15.0.0
  `Cargo.lock` and checksum-verified crate archives. This includes build and test
  dependencies as a conservative superset of the six shipped targets. MIT is
  selected wherever offered; `ryu` uses BSL-1.0. Additional WHATWG, Unicode and
  Crossbeam third-party notices are included.

The sljit notice is copied from the `sljitLir.c` header in the checksum-verified
`pcre2-sys-0.2.10` archive (which omits the standalone sljit license file).

When updating `@vscode/ripgrep-universal`, check the matching upstream lockfile
and refresh these notices from the exact crate archives; binary strings alone
cannot enumerate dependencies reliably.

The jemalloc and libunwind notices apply to the Linux binaries only; `strings` finds their symbols in
`linux-x64` and `linux-arm64` and in neither the darwin nor win32 builds.
