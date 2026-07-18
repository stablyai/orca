# Codex Shift+Enter 줄바꿈 재발 수정

## 현재 판단

- As-is: 수정 전 설치본은 Codex pane에서도 Kitty/host 기본 Shift+Enter 바이트를 보내 줄바꿈이 다시 실패했다.
- To-be: Codex로 확인된 pane은 LF를 보내고, 종료 뒤 shell 및 다음 Codex 실행 세대에서는 각각 안전하게 차단·복구한다.
- 07/18 설치된 Orca 1.4.144-rc.4에는 이전 Codex 전용 Shift+Enter 수정이 포함되지 않았다.
- 현재 설치본은 Codex pane에서 Shift+Enter를 LF로 보내는 수정본으로 교체됐다.
- 이전 수정은 별도 dirty worktree에만 남아 있었고 최신 모바일 연결 빌드에 합쳐지지 않았다.

## 작업 계약

- 최신 1.4.144 모바일 연결 변경을 보존한 채 Codex로 확인된 pane에서만 Shift+Enter를 Ctrl+J 줄바꿈 바이트로 보낸다.
- 일반 shell, 다른 agent, Windows 전용 Droid 처리, Kitty keyboard 동작은 기존 의미를 보존한다.
- 실패 테스트를 먼저 확인하고 최소 구현, 관련 단위·통합 테스트, 타입 검사를 실행한다.
- 앱 종료·교체·재시작과 원격 반영은 사용자 명시 승인 뒤 수행한다. 사용자는 설치본 검증 뒤 커밋·배포까지 완료하도록 승인했다.

## Context Lens

- Required: yes
- Primary lens: engineering
- Secondary lens: product
- Why this lens: terminal 입력·세션 복구의 기술 정확성과 사용자가 실제로 보는 줄바꿈 행동을 함께 검증해야 한다.
- Source: 사용자 재현, 설치본과 최신 소스 비교, terminal lifecycle 회귀 테스트, 실제 재시작 세션 목록.
- Applied checks: Codex pane 범위, 일반 shell·다른 agent 비회귀, 로컬·SSH·WSL 종료와 재실행, 동일 PTY 복구, 실제 UI 키 입력.

## 완료 기준

- Codex pane의 Shift+Enter가 host OS와 Kitty 상태에 관계없이 LF를 보내는 테스트가 통과한다.
- stale local agent identity는 일반 shell 입력을 바꾸지 않고, 로컬 확인이 어려운 SSH·WSL만 pane identity fallback을 사용한다.
- 관련 회귀 테스트와 타입 검사가 통과한다.
- 사용자 승인 뒤 앱을 교체·재시작하고 기존 세션의 동일 PTY 복구를 확인한다.

## 지침 적용 확인

- 읽은 기준: 전역·저장소 `AGENTS.md`, instruction manifest, `CODEX.md`, `MEMORY.md`, Codex 최신 세션·archive, session·development·API·사람 문장·터미널 출력·Markdown 기준, 기존 Shift+Enter 작업 기록. API 기준이 요구한 `CLAUDE.md`는 현재 경로에 존재하지 않았다.
- 선택 bundle/lens: `code`, engineering, cross-platform terminal input correctness.
- 적용 skill: `tdd-workflow`, `orca-cli`, `computer-use`, `deploy`.
- 적용 기준: 최신 모바일 연결 작업 보존, 테스트 우선, Codex pane 범위 제한, 앱 재시작 보호, 독립 검토.
- 해당 없음: 외부 API, 운영 데이터, 외부 발송, 브라우저 원문 조회.
- 배포 범위가 추가된 뒤 release 기준과 프로젝트별 배포 절차를 다시 확인했다.

## API 작업 체크리스트

- 요청 원문: 설치·재시작 뒤 세션을 이어가고 Shift+Enter 재발을 막는다.
- 작업 분류: local read-only 조회와 실제 키 입력 검증.
- 대상 API: 실행 중인 Orca의 localhost DevTools endpoint.
- 환경: local.
- method: GET 조회 후 로컬 DevTools WebSocket 키 이벤트 전달.
- payload: 선택된 Orca renderer에 Shift+Enter 키 이벤트 1회.
- auth/account: localhost의 현재 사용자 세션, 별도 계정·토큰 없음.
- 대상 객체: 현재 Orca renderer와 검증용 terminal pane.
- 예상 화면 변화: 검증 pane의 입력창에 줄바꿈 1회 추가.
- 영향 범위: 로컬 Orca UI 한 pane, 외부 전송 없음.
- rollback: 검증용 입력을 지우거나 검증 pane을 닫는다.
- 검증 방법: PTY 입력 바이트 또는 composer의 줄 수를 전후 비교한다.
- 실행 주체: Codex 가능.

## 검증 기록

- 설치본 대조: 1.4.144-rc.4 renderer의 Shift+Enter 분기는 Codex 판별 없이 CSI-u 또는 Esc+Enter만 선택한다.
- 소스 대조: 기존 dirty 작업공간의 구현을 `origin/main` 기준 독립 브랜치로 분리해 커밋했다.
- RED: Codex LF 라우팅, 종료 뒤 stale identity 차단, 포커스·idle 중 trust 유지, 원격 launch-only 종료와 재실행 generation 테스트가 구현 전 각각 실패함을 확인했다.
- GREEN: 관련 단위·통합 7개 파일 541개 테스트, 타입 검사, 포맷 검사, diff 검사가 통과했다.
- Electron: terminal shortcuts 시나리오 7개 통과, Windows 전용 2개는 macOS에서 예정대로 skip됐다.
- 독립 검토: local stale identity, 포커스 재확인, 원격 fallback, launch-only 종료, 재실행 generation, production store 동일성 문제를 순차 보완한 뒤 최종 승인됐다.
- 설치 후보: Orca 1.4.144-rc.4 arm64 앱 생성, deep codesign 검증 통과, 패키지 renderer에서 Codex `ctrl-j`와 generation tombstone 분기를 확인했다.
- 사용자 승인 뒤 앱을 교체·재시작했고, runtime은 새 ID로 ready 상태가 됐다.
- 작업 중 생긴 mobile transport 변경은 별도 동시 작업으로 판단해 수정하거나 되돌리지 않았다.
- 재시작 승인 직전 runtime은 ready였고, 9개 terminal 모두 connected·writable 상태였다. 동일 PTY identity와 개수를 재시작 후 복구 기준으로 사용한다.
- 재시작 뒤에도 기존 PTY 9/9가 보존됐고, terminal 9개 모두 connected·writable이었다. 새 PTY 대체나 누락은 0개였다.
- 설치된 앱의 version은 1.4.144-rc.4이며 Finder metadata를 정리한 뒤 deep codesign 검증을 통과했다. 이전 앱은 명시적 backup 경로에 복구 가능하게 보존했다.
- 실제 UI 키 입력 자동화는 macOS Accessibility가 새 helper에 허용되지 않아 실행하지 못했다. 임시 검증 tab은 닫았고 기존 9개 세션에는 입력하지 않았다. 제품 Electron shortcut E2E의 Codex LF 검증은 7 passed/2 platform-skip 상태다.
- Shift+Enter 수정만 `origin/main` 기준 독립 브랜치로 분리해 커밋했으며, 동시 작업 중인 mobile transport 변경은 포함하지 않았다.
- 깨끗한 독립 브랜치에서 타입 검사, 관련 7개 파일 541개 테스트, desktop production build가 다시 통과했다. 기존 CSS·chunk 경고와 선택적 CLI symlink 권한 안내 외 빌드 실패는 없었다.

## Goal

- Codex pane에서 Shift+Enter 줄바꿈을 복구하고, 설치 교체와 이후 소스 반영에서도 같은 문제가 재발하지 않게 한다.

## In Scope

- Codex 전용 LF 라우팅, agent identity lifecycle, 로컬·SSH·WSL 회귀 테스트, 앱 설치, 독립 커밋과 원격 반영이다.

## Out of Scope

- 동시 작업 중인 mobile transport 변경, 일반 shell·다른 agent의 키 동작 변경, Accessibility 권한 변경이다.

## Instruction Receipt

- Read docs: 전역·저장소 `AGENTS.md`, instruction manifest, `CODEX.md`, session·development·release·workflow·operating-change·product·Markdown·사람 문장 기준을 읽었다.
- Selected bundle/lens: `code`, `release`, `markdown_docs`, `operating`, `po_context`; engineering과 product lens를 선택했다.
- Applied instructions: 사용자 세션 보존, 테스트 우선, 독립 브랜치 분리, 테스트·빌드 통과 뒤 commit·push, main 직접 push 금지와 PR 경유 절차를 적용했다.
- N/A or deferred: 고객 운영 데이터·백오피스·외부 발송은 해당 없고, 실제 OS 키 주입은 Accessibility 제한으로 자동화하지 못해 제품 E2E로 보완했다.
- Re-read trigger: 배포 대상이나 release 방식이 바뀌면 저장소 release 기준과 `deploy` 절차를 다시 읽는다.

## Done Means

- 설치본에서 기존 9개 PTY가 유지되고, Codex Shift+Enter 회귀 테스트와 production build가 통과하며, 수정 커밋이 원격 공식 반영 경로에 존재한다.

## Verification Plan

- 타입 검사, 관련 541개 테스트, Electron shortcut E2E, desktop production build, 설치본 codesign·패키지 분기, 재시작 전후 PTY identity를 확인한다.

## Risks

- 실제 OS 키 주입은 Accessibility 제한으로 자동화하지 못했다. 제품 E2E와 패키지 확인으로 보완했다.
- 두 로컬 GitHub 계정 모두 공식 저장소에는 read 권한만 있어 main 반영은 maintainer merge가 필요하다. 개인 fork에 커밋을 push하고 공식 저장소 PR #9273을 생성해 소스 유실 가능성을 제거했다.

## Release / Handoff

- 로컬 배포: 서명된 Orca 1.4.144-rc.4 수정본을 설치하고 재시작했으며 기존 PTY 9/9가 유지됐다.
- 원격 배포: `beige-ian/orca`의 `fix/codex-shift-enter-durable` 브랜치에 push했고, `stablyai/orca` main 대상 PR #9273이 열려 있다.
- 현재 PR은 merge 가능한 상태이며 GitHub 검사가 실행 중이다. 공식 main 병합은 저장소 write 권한이 있는 maintainer가 수행한다.
