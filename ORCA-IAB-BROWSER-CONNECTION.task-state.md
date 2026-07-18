# Orca 브라우저 플러그인 직접 연결

## Linear Source
- 이슈: N/A
- 링크: N/A
- 상태: completed
- 담당: Codex

## Goal
- 열린 Orca 브라우저 패널을 Browser 플러그인이 직접 발견하고 선택하도록 연결 정보를 전달합니다.

## PRD / Problem
- 패널은 화면에 있고 Orca 전용 제어도 되지만 Browser 플러그인 목록은 비어 있습니다. 규칙 우회가 아니라 세션 연결 정보를 실제 플러그인까지 전달해야 합니다.

## Background
- 현재 Orca 패널은 같은 작업공간의 활성 탭이며 URL과 화면 구조 조회가 성공합니다.
- 같은 Codex 세션에서 Browser 플러그인 런타임을 초기화하면 브라우저 목록은 빈 배열이고 요청 메타데이터에는 브라우저 대상 정보가 없습니다.

## Why It Matters / Why Now
- 보이는 패널을 다시 열라고 안내하면 사용자가 현재 화면을 신뢰할 수 없습니다.
- 규칙 우회는 다른 세션이나 새 세션에서 다시 깨질 수 있으므로 연결 계층을 지금 고쳐야 합니다.

## Problem Definition
- Orca 안에 활성 브라우저가 있어도 새 Codex 턴의 Browser 플러그인에서 `iab`가 발견되지 않습니다.

## Solution Intent
- 세션 생성·재개 시 현재 보이는 Orca 브라우저의 연결 정보가 플러그인 런타임에 전달되게 합니다.

## Hypothesis
- Codex 세션/도구 요청을 만드는 경계에서 활성 Orca 브라우저 정보를 누락해 Browser 플러그인이 백엔드를 만들지 못합니다.

## Approach
- 기존 세션의 변경이 섞인 checkout은 보존하고 독립 worktree에서 재현 테스트를 먼저 작성합니다.
- Orca CLI 우회만 유지하는 방식과 Browser 플러그인 파일을 직접 수정하는 방식은 버립니다. 제품의 세션 연결 경계를 수정합니다.

## Validation Plan / Implementation Plan
- 연결 정보 생성 경로를 좁혀 실패 테스트를 작성합니다.
- 최소 구현으로 테스트를 통과시킨 뒤 타입 검사와 관련 통합 테스트를 실행합니다.
- 별도 dev Orca에서 브라우저 패널과 새 Codex 세션을 열어 Browser 플러그인이 `iab`를 직접 발견하고 화면을 읽는지 확인합니다.

## Success Metrics / Failure Metrics / Completion Evidence
- Success metrics: 새 세션에서 Browser 플러그인 목록에 `iab`가 한 개 나타나고 현재 보이는 패널을 선택합니다.
- Failure metrics: 목록이 비어 있거나 숨겨진/다른 작업공간 탭을 선택하거나 Orca CLI 우회가 필요합니다.
- Completion evidence: 실패→성공 테스트, 타입 검사, 관련 통합 테스트, 별도 dev 런타임의 직접 연결과 화면 읽기 결과입니다.

## History
- 07/17 패널 배치와 Orca 전용 제어는 확인했으나 Browser 플러그인의 직접 발견은 실패했습니다.

## Current Status
- 직접 연결 구현, dev·실사용 앱 검증, 독립 리뷰, 전체 빌드, 커밋, 개인 fork 백업과 `/Applications/Orca.app` 반영을 완료했습니다. 재시작된 실사용 Orca에서 공식 Browser가 현재 폴더 브라우저를 직접 발견했고 동일 탭 이동과 새 연결 재인식을 확인했습니다.

## Context Lens
- Required: yes
- Primary lens: engineering
- Secondary lens: product
- Why this lens: 세션과 브라우저 연결 계약을 고치면서 사용자가 보는 현재 패널과 정확히 일치해야 합니다.
- Source: 현재 Orca 탭 상태, Browser 플러그인 발견 결과, 새 worktree의 제품 코드와 테스트
- Applied checks: 다른 세션 보존, 현재 표시 탭 일치, 새 세션 재현, SSH·Windows·Linux 호환, 우회 없는 직접 연결

## Instruction Receipt
- Read docs: `/Users/wjh/AGENTS.md`, worktree `AGENTS.md`, `ORCA-IAB-BROWSER-CONNECTION.task-state.md`, instruction manifest, Codex/session/communication rules, development/workflow/API/release/browser rules, Browser plugin·Orca CLI·TDD·deploy skills, Browser client의 발견·응답 메타데이터 코드
- Selected bundle/lens: `base`, `code`, `api`, `browser`, `release`; engineering + product
- Applied instructions: 독립 worktree, 테스트 선작성, 실제 dev 화면 검증, peer 검토, 다른 세션과 사용자 변경 보존, 현재 표시 패널만 직접 연결, deploy 절차의 빌드·테스트·실사용 검증 및 커밋·push 전 사용자 확인
- Latest review applied: native socket별 CDP 소유권·재연결 cleanup, 지원 API 축소 광고, backend 시작 실패 격리, local/live/unique resolver와 reconnect 테스트를 완료 조건에 추가
- N/A or deferred: 외부 서비스 변경은 요청 범위 밖입니다. 커밋·통합·기존 Orca 앱 반영은 07/18 사용자의 후속 요청으로 범위에 추가됐습니다.
- Re-read trigger: 대상 경로가 세션 연결이 아닌 플러그인 패키지나 외부 Codex 호스트로 바뀌는 경우입니다.

## Working Contract
- In scope: Orca가 Codex Browser 플러그인에 현재 활성 브라우저 정보를 전달하는 코드와 관련 테스트, 커밋·안전한 통합·실사용 앱 반영·최종 QA
- Out of scope: 다른 작업 세션 중단, 기존 dirty checkout의 관련 없는 수정, Safari/Chrome/Playwright 우회, 외부 서비스 변경
- Done means: 별도 dev Orca와 반영된 실사용 Orca의 새 Codex 세션에서 Browser 플러그인이 현재 패널을 직접 발견하고 화면을 읽습니다.
- How to verify: 실패 테스트, 관련 테스트·타입 검사, dev 런타임 새 세션의 `iab` 발견과 URL/가시 상태 확인
- Main risks: 연결 정보 규약이 Orca 저장소 밖 Codex 호스트에만 있거나, dev 앱과 현재 플러그인 버전이 호환되지 않을 수 있습니다.

## API 작업 체크리스트
- 요청 원문: 완벽한 해결을 원한다.
- 작업 분류: 로컬 세션 연결 계약 수정
- 대상 API: Orca와 Codex 도구 요청 사이의 브라우저 연결 메타데이터
- 대상 환경: local dev
- method: 로컬 IPC/MCP 세션 초기화
- payload: 현재 작업공간과 현재 표시 브라우저를 식별하는 최소 연결 정보
- auth/account: 없음
- 대상 객체: 별도 dev Orca의 새 Codex 세션과 브라우저 패널
- 예상 화면 변화: 새 세션이 이미 열린 브라우저를 즉시 제어 가능
- 영향 범위: Orca가 시작한 Codex 세션
- rollback: 독립 worktree 변경을 폐기하고 현재 설치 앱을 유지
- 검증 방법: 새 세션에서 Browser 플러그인 직접 발견과 화면 읽기
- 실행 주체: Codex 가능

## Design / Decisions
- 연결 대상은 같은 작업공간의 현재 표시 브라우저 하나여야 합니다.
- 연결 정보가 없을 때 다른 브라우저로 자동 전환하지 않습니다.
- POSIX Browser client는 `/tmp/codex-browser-use` 디렉토리의 하위 소켓을 열거하므로 Orca 인스턴스별 소켓을 그 아래에 생성합니다.
- 요청 `session_id`는 live local Codex pane의 provider session과 정확히 일치할 때만 worktree로 해석하며, 한 socket 연결에서 다른 session id로 변경할 수 없습니다.
- Browser Use CDP는 Electron WebContents에 직접 명령만 던지지 않고 기존 `CdpWsProxy`의 target/session·navigation·screenshot 보정 경로를 전용 연결로 재사용합니다.
- SSH 세션은 local pipe에 잘못 연결하지 않으며, 이번 macOS local 검증만으로 SSH·Windows 지원 완료를 주장하지 않습니다.

## AI Operating Model
- AI에게 맡길 일: 코드 경로 조사, 테스트·구현, dev 검증, 회귀 위험 점검
- 사람이 직접 결정할 일: 운영 앱 설치·배포 여부
- 검증/근거 산출물: 테스트 결과, dev 세션의 직접 연결 결과, 독립 리뷰
- 품질 루프 강도와 확인 내용: 실패 비용이 높은 연결 수정으로 테스트·실행·peer 3단 확인

## Operating Cadence
- owner: Codex
- due: 현재 세션
- readout date: 07/17
- kill criteria: 제품 저장소 밖의 비공개 Codex 호스트 변경 없이는 직접 연결을 구현할 수 없음이 증명되는 경우
- review cadence: 원인 확정 후 1회, 구현 후 1회, 완료 전 1회

## Implementation Log
- 07/17 독립 worktree 생성 및 Browser 플러그인 빈 목록 재현
- 07/17 Browser client가 `/tmp/codex-browser-use/<name>`을 열거하고 4-byte little-endian JSON-RPC frame으로 `getInfo`를 호출하는 계약 확인
- 07/17 실패 테스트 선작성 후 native-pipe backend, session/worktree/tab mapping, connection session binding 구현
- 07/17 AgentBrowserBridge가 worktree-scoped WebContents에 전용 `CdpWsProxy`를 만들도록 연결하고, CDP request/event/target attach 어댑터 구현
- 07/17 독립 아키텍처 리뷰 수행: stale status, 다중 세션, 전체 protocol, CDP lifecycle, SSH 경계를 차단 이슈로 반영
- 07/17 관련 단위 테스트 2개와 전체 TypeScript typecheck 통과
- 07/17 설치 앱과 분리된 `IAB Direct Connection QA` dev Orca 기동
- 07/18 Browser client의 IAB 필터가 요구하는 `codexAppBuildFlavor: "prod"` 계약을 확인하고 응답에 반영
- 07/18 정리된 최종 dev 빌드에서 공식 Browser 런타임이 `iab` 선택 후 `https://example.com/`, `Example Domain`, 본문을 직접 읽음
- 07/18 세션 전환 차단과 CDP 라우팅 회귀 테스트를 추가하고 당시 관련 테스트 5개, 전체 타입 검사, 변경 파일 lint 통과
- 07/18 native 연결 소유권을 모든 target/CDP 호출에 적용하고 탭별 attach 직렬화, 이전 owner 거부, 동시 attach 테스트 추가
- 07/18 렌더러 process swap 시 stale CDP 연결 종료·새 프록시 재생성·진행 중 명령 1회 재시도 경로 추가
- 07/18 최상위 `Page.navigate`를 renderer 소유 탭 모델과 `<webview>.src` 갱신 경로에 연결
- 07/18 최종 dev 빌드에서 같은 Browser/tab 객체의 `example.com` → `example.org` 이동과 URL·제목·본문 읽기 성공, 별도 새 Browser 연결에서도 같은 tabId와 동일 콘텐츠 재확인

## Recent Changes
- 규칙 우회가 아니라 Orca main process가 Browser 플러그인의 native-pipe backend가 되도록 제품 연결 계층을 추가했습니다.

## Remaining Work
- [x] 연결 정보 생성·전달 경로 확인
- [x] 실패 테스트 작성 및 재현
- [x] 최소 구현과 관련 테스트 통과
- [x] 별도 dev Orca의 새 세션 직접 연결 검증
- [x] 독립 리뷰와 Done gate
- [x] 전체 desktop/native 빌드 통과
- [x] 변경 로컬 커밋
- [x] 개인 fork 원격 백업
- [x] 실사용 Orca 앱 반영과 최종 QA

## Risks / Blockers
- macOS local Codex 직접 연결과 process-swap 이동에는 코드 blocker가 없습니다.
- SSH 세션은 local pipe 대상에서 제외했습니다. Windows named pipe 경로는 구현했지만 이번 macOS 환경에서는 실행 검증하지 않았습니다.
- 잘못되거나 분할된 JSON-RPC frame에 대한 추가 방어 테스트는 후속 hardening 후보이며 현재 macOS local 목표의 완료 차단 사항은 아닙니다.
- 원본 `stablyai/orca`에는 두 개인 계정 모두 쓰기 권한이 없어, 사용자 승인에 따라 `jeonghoon0126/orca` 개인 fork에 백업했습니다.

## Verification
- 명령/방법: 관련 테스트, 타입 검사, 별도 dev 런타임의 Browser 플러그인 직접 연결
- 결과: Browser 연결 테스트 15개와 기존 AgentBrowserBridge 회귀를 포함한 관련 테스트 99개, 전체 TypeScript typecheck, 변경 파일 oxlint, `git diff --check`, 전체 desktop/native 빌드와 서명 검증 통과. dev 앱뿐 아니라 교체·재시작한 실사용 Orca에서도 공식 Browser가 `example.com`을 직접 읽고 같은 객체로 `example.org` 이동 후 URL·제목·본문을 읽었으며, 새 Browser 연결에서 같은 탭을 재인식했습니다. 검증용 탭은 정리하고 기존 사용자 탭은 보존했습니다.

## Release / Handoff
- 배포/반영 방식: 서명된 macOS unpack 앱을 `/Applications/Orca.app`에 반영하고 재시작
- 운영 전달사항: 이전 앱은 `/Applications/Orca.app.pre-iab-backup`에 복구용으로 보존, 사용자 데이터와 기존 탭 유지
- 원격 반영: `jeonghoon0126/orca` 개인 fork의 해결 브랜치

## Final Outcome
- Browser 패널 직접 발견 문제를 코드·dev 앱·실사용 앱에서 해결했습니다. 설치 앱 교체 후 동일 탭 이동과 새 연결 재인식까지 통과했으며 blocker는 없습니다.

## Independent Review
- Contract met: yes
- Out-of-scope preserved: yes
- Verification evidence present: yes
- Ready for next session: yes
- Result: blocker 0개 / major 0개 / minor 2개. minor는 문서 최신화와 protocol negative coverage이며 현재 완료 범위를 막지 않음

## Compact Preservation
- Current work / 현재 작업: Orca Browser 플러그인 직접 연결·교차 출처 이동·재접속 구현, dev·실사용 검증, 앱 반영 완료
- User request / 사용자 요청: 규칙 우회가 아닌 완벽한 해결
- Decision rationale / 판단 이유: 패널은 정상이고 플러그인 요청에 브라우저 정보가 없습니다.
- Decisions / 확정 판단: 독립 worktree, 테스트 우선, dev 새 세션 직접 검증
- Rejected paths / 버린 대안: Orca CLI만으로 완료 처리, 기존 dirty checkout 수정, 다른 브라우저 전환
- Evidence source paths / 근거 경로: 현재 작업 문서와 조사 후 확정할 코드·테스트
- Verification / 검증: 공식 Browser 런타임 `iab` 발견, 같은 tab 객체의 `example.com` → `example.org` 이동과 새 connection 재접속 성공, 관련 테스트 99개·typecheck·lint·diff check 통과
- Remaining risk / 남은 리스크: Windows와 SSH 원격 실행, protocol negative coverage는 이번 macOS local 완료 범위 밖
- Resume next action / 재개 첫 행동: 없음. 후속 hardening이 필요하면 별도 작업으로 시작

## Next Step
- 다음 세션이 바로 실행할 첫 행동 1개: 없음 — 현재 완료 상태 유지
- 이어 쓰면 안 되는 별도 작업: 기존 Shift+Enter 및 다른 Orca 기능 수정
