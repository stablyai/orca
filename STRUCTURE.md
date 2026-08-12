# STRUCTURE — orca

> 폴더 명명 정본은 orca-system [`DOCS-CONVENTION.md §8`](../orca-system/DOCS-CONVENTION.md)이다.
> 이 문서는 그 규칙이 이 레포에 실제로 어떻게 적용됐는지의 지도다. 2026-08-08 폴더 명명 전수 조사·정리 기준.

## ⚠ 이 레포 전체는 서드파티 포크(§0 카브아웃)

`stablyai/orca`의 포크. 이 fork는 origin/main보다 커밋 다수 뒤처져 있다(정확한 수치·판정 기준은
아래 "미해결" 참조) — merge-base가 origin/main과 붙어있는 "사실상 동기화" 상태가 아니다.
`src/`·`native/`·`build-plugins/`·`Casks/`·`tests/`·`resources/`·`.husky/` 등 업스트림 코드
구조 자체를 재작성하지는 않지만, 완전 무편집도 아니다: `feat/gajae-code-agent` 브랜치가 기존
에이전트 카탈로그/설정 테이블에 소규모 additive 변경(13개 파일, 40줄)을 냈다. docs/notes/tools의
조사문서 외에 이 신규 기능 추가가 있었다는 뜻이다.

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

- `docs/*.md` 41개(레포 자신의 durable 정책 위반하며 tracked 상태였음) → `docs/reference/`로 이관.
  ⚠ 이때 "업스트림에 없으니 fork 고유 콘텐츠"라고 판정한 게 틀렸음(2026-08-09 재감사에서 발견) —
  실제로는 업스트림 저작 파일을 업스트림이 삭제한 것. 2026-08-12에 업스트림 논리를 따라 41개를
  `docs/reference/`에서 다시 삭제해 해소(아래 절 참고).
- `TERMINAL-GARBLE-INVESTIGATION.md` + 관련 스크립트 4개(`tools/terminal-garble-*.mjs`) →
  `20260717_terminal-garble/` 작업단위로 통합(report.md + 스크립트, 상대경로 import 4곳 수정)
  ⚠ 그때 `production-repro.mjs`의 `REPLAY_SCRIPT`는 import가 아니라 cwd 기준 경로 문자열이라 놓쳤고,
  없어진 `tools/terminal-garble-session-replay.mjs`를 계속 가리키고 있었다(2026-08-08 재감사에서 발견,
  `import.meta.url` 기준 형제 참조로 수정). **개명 시 import뿐 아니라 평문 경로 문자열도 grep할 것.**
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

- `tools/spikes/`는 2026-08-08에 죽은 폴더로 확인돼 삭제됨(해소).

## 업스트림 저작 파일 재배치 오판정 — 해소 (2026-08-12)

2026-08-08에 `docs/*.md` 41개를 `docs/reference/`로 옮기면서 "업스트림 `origin/main`엔 없으니
fork 고유 콘텐츠"라고 판정했는데 **판정 방법이 틀렸다**. `git cat-file -e <merge-base>:<path>`로
재확인한 결과 41개 전부 `merge-base`(057a8149)에 존재해 업스트림 저작이었고, 현재 origin/main에
없는 이유는 업스트림이 그 사이 **삭제**했기 때문이었다(재검증: 2026-08-12, 41/41 merge-base에
존재·41/41 현재 origin/main에 부재).

**소유자 판단(2026-08-12): 업스트림 논리를 따른다.** `origin`은 `stablyai/orca`이고 이 저장소를
소유·통제하는 건 그쪽이지 이 fork(`noobear` 리모트)가 아니다 — 업스트림이 이미 지운 파일을 fork가
`docs/reference/`에 남겨둘 근거가 없다. 41개 파일을 `docs/reference/`에서 삭제해 업스트림 상태에
맞췄다. 이 fork가 향후 업스트림과 실제로 리베이스/머지할 계획이 있을 때만 "유지" 판단이 의미가
있었는데, 그 계획이 없어 되돌리는 쪽으로 정리한다.

→ 판정 기준(재사용): `git cat-file -e <merge-base>:<path>`로 저작 출처를 가른다. "현재 업스트림에
없다"는 "우리가 만들었다"와 다르다.
