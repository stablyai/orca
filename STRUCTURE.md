# STRUCTURE — orca

> 폴더 명명 정본은 orca-system [`DOCS-CONVENTION.md §8`](../orca-system/DOCS-CONVENTION.md)이다.
> 이 문서는 그 규칙이 이 레포에 실제로 어떻게 적용됐는지의 지도다. 2026-08-08 폴더 명명 전수 조사·정리 기준.

## ⚠ 이 레포 전체는 서드파티 포크(§0 카브아웃)

`stablyai/orca`의 포크. `src/`·`native/`·`build-plugins/`·`Casks/`·`tests/`·`resources/`·`.husky/` 등
업스트림 코드 구조는 **건드리지 않는다**(merge-base가 origin/main과 거의 붙어있어 사실상 upstream
동기화 상태 — docs/notes/tools의 조사문서만 이 사용자가 직접 추가한 것).

## 문서 슬롯 (레포 자체 정책, .gitignore로 강제)

| 폴더 | 역할 |
|---|---|
| `docs/reference/` | **durable** — 커밋 대상 조사·설계 문서. `YYYY-MM-DD-<topic>.md` 권장 |
| `docs/assets/` | README 등에서 실제로 참조하는 이미지(URL 예외) |
| `docs/readme/` | GitHub OSS i18n 관례(`README.es.md` 등) |
| `docs/STYLEGUIDE.md` | 화이트리스트 예외 |
| `docs/` 루트(위 4개 밖) | **ephemeral** — gitignore 기본, 커밋되면 안 됨(레포 자신의 .gitignore 주석: "Local-only design/planning docs") |
| `notes/` | 스킬 시스템 설계안 |
| `tools/` | 조사·재현 스크립트(daemon-relocation-spike, repro-*, win-update-e2e 등) |
| `mobile/` | Expo/React Native 컴패니언 앱 소스 — 코드 모듈, 조사문서 끼면 안 됨 |

## ⚠ 예외 — 리네임 금지

`skills/*`, `skill-guides/*`(스킬 로더가 폴더명을 리터럴 참조), `tools/benchmarks/results/`(스크립트
하드코딩), `docs/assets/feature-wall/*`(README 9회 실참조), `tools/repro-watcher-crash-7547/`·
`tools/win-update-e2e/`(README에 `node tools/<폴더명>/run.cjs` 실행경로 하드코딩).

## 2026-08-08 정리 이력

- `docs/*.md` 41개(레포 자신의 durable 정책 위반하며 tracked 상태였음) → `docs/reference/`로 이관
  (업스트림 `origin/main`엔 이 41개가 없음을 `git diff` 확인 후 진행 — 이 fork 고유 콘텐츠)
- `TERMINAL-GARBLE-INVESTIGATION.md` + 관련 스크립트 4개(`tools/terminal-garble-*.mjs`) →
  `20260717_terminal-garble/` 작업단위로 통합(report.md + 스크립트, 상대경로 import 4곳 수정)
- `mobile/*.md` 조사문서 3개 → `docs/reference/YYYY-MM-DD-*.md`(코드 루트에서 분리)
- 소스코드 3곳(`src/relay/wsl-hook-fs-bridge.ts` 등)의 `docs/agent-status-over-wsl.md` 주석 참조를
  새 경로로 갱신
- `tools/spikes/` 삭제 — `.gitignore`(`*.png`) 한 줄뿐이고 tracked 파일도 그것 하나, 레포 전체에서
  참조 0건인 죽은 폴더로 확인됨

## ⚠ `tools/daemon-relocation-spike/`는 리네임 대상 아님

README가 스스로를 "throwaway probe"라 부르고 `spike-<topic>` 어휘 순서와도 반대지만, 실제 내용은
`cli.mjs`·`selftest.mjs` 포함 11파일짜리 **재사용 가능한 하네스**다. 코드모듈 예외로 인정하고
이름을 유지한다(2026-08-08 판단).

## 미해결

- 없음(2026-08-08 기준). `tools/spikes/`는 같은 날 죽은 폴더로 확인돼 삭제됨.
