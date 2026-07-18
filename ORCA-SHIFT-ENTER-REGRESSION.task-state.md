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
- 앱 종료·교체·재시작은 사용자 명시 승인 전에는 수행하지 않는다. 커밋·푸시도 수행하지 않는다.

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
- 적용 skill: `tdd-workflow`, `orca-cli`, `computer-use`.
- 적용 기준: 최신 모바일 연결 작업 보존, 테스트 우선, Codex pane 범위 제한, 앱 재시작 보호, 독립 검토.
- 해당 없음: 외부 API, 운영 데이터, 외부 발송, 브라우저 원문 조회.
- 다시 읽을 조건: 앱 설치·재시작 또는 배포 범위가 추가될 때 release 기준을 다시 읽는다.

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
- 소스 대조: 별도 Shift+Enter 작업공간에는 Codex pane을 Ctrl+J로 제한하는 미커밋 구현과 회귀 테스트가 남아 있다.
- RED: Codex LF 라우팅, 종료 뒤 stale identity 차단, 포커스·idle 중 trust 유지, 원격 launch-only 종료와 재실행 generation 테스트가 구현 전 각각 실패함을 확인했다.
- GREEN: 관련 단위·통합 6개 파일 541개 테스트, 타입 검사, 포맷 검사, diff 검사가 통과했다.
- Electron: terminal shortcuts 시나리오 7개 통과, Windows 전용 2개는 macOS에서 예정대로 skip됐다.
- 독립 검토: local stale identity, 포커스 재확인, 원격 fallback, launch-only 종료, 재실행 generation, production store 동일성 문제를 순차 보완한 뒤 최종 승인됐다.
- 설치 후보: Orca 1.4.144-rc.4 arm64 앱 생성, deep codesign 검증 통과, 패키지 renderer에서 Codex `ctrl-j`와 generation tombstone 분기를 확인했다.
- 사용자 승인 뒤 앱을 교체·재시작했고, runtime은 새 ID로 ready 상태가 됐다.
- 작업 중 생긴 mobile transport 변경은 별도 동시 작업으로 판단해 수정하거나 되돌리지 않았다.
- 재시작 승인 직전 runtime은 ready였고, 9개 terminal 모두 connected·writable 상태였다. 동일 PTY identity와 개수를 재시작 후 복구 기준으로 사용한다.
- 재시작 뒤에도 기존 PTY 9/9가 보존됐고, terminal 9개 모두 connected·writable이었다. 새 PTY 대체나 누락은 0개였다.
- 설치된 앱의 version은 1.4.144-rc.4이며 Finder metadata를 정리한 뒤 deep codesign 검증을 통과했다. 이전 앱은 명시적 backup 경로에 복구 가능하게 보존했다.
- 실제 UI 키 입력 자동화는 macOS Accessibility가 새 helper에 허용되지 않아 실행하지 못했다. 임시 검증 tab은 닫았고 기존 9개 세션에는 입력하지 않았다. 제품 Electron shortcut E2E의 Codex LF 검증은 7 passed/2 platform-skip 상태다.
