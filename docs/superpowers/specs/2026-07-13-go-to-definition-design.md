# Go to Definition (심볼 인덱스 기반) — 설계 문서

- 날짜: 2026-07-13
- 대상 레포: stablyai/orca (upstream PR 목표)
- 브랜치: `feat/go-to-definition`

## 배경 / 문제

Orca의 Monaco 에디터는 의도적으로 "타입 체커가 아닌 뷰어/diff 표면"으로 설계돼 있다
(`src/renderer/src/lib/monaco-setup.ts` 주석: *"Monaco here is a viewer/diff surface,
not a type checker — users edit real code in their own IDE. The sandboxed TS worker
cannot resolve imports to project files"*). 그래서 semantic/syntax validation이 전부
꺼져 있고, PyCharm의 Cmd+B / VS Code F12 같은 "정의로 이동"이 없다.

이미 전신 격 기능과 로드맵 힌트가 있다: `src/renderer/src/components/editor/monaco-codebase-search.ts`
는 커서 위치 심볼을 코드베이스 텍스트 검색으로 여는 affordance를 제공하며, 주석에
*"until Orca has semantic LSP references, the editor affordance should still work from a
cursor by searching the visible symbol text in files"* 라고 남겨 두었다. 이 PR은 그
확장 지점을 채운다.

## 목표 / 비목표

**목표**
- 커서 아래 심볼에서 Cmd+B / F12 / Cmd+클릭으로 정의 위치로 점프.
- 정의가 여러 개면 Monaco peek 위젯으로 후보 목록 표시.
- 정의를 못 찾으면 기존 "Search in Files" 동작으로 조용히 폴백(회귀 없음).
- 언어 무관 구조. 1차 지원: TypeScript / JavaScript / TSX / Python / Go / Rust / Java.

**비목표**
- 진짜 LSP/타입 해석(스코프·타입 기반 정확한 심볼 해소). 이름 기반 인덱스의 한계를
  명시적으로 수용한다. 동명이인은 후보 목록으로 노출.
- Find References, Rename, Hover 타입 정보 등 여타 언어 기능.
- 크로스 워크트리 조회(각 워크트리 루트별 인덱스로 한정).

## 접근 방식

심볼 인덱스 기반. tree-sitter(web-tree-sitter, wasm)로 각 파일을 파싱해 정의 노드
(함수·클래스·메서드·변수·타입 등)를 추출하고, 워크트리 루트별 name→정의위치 테이블을
메인 프로세스에 유지한다. Renderer의 Monaco DefinitionProvider가 커서 심볼명을 IPC로
질의해 위치들을 받아 점프/peek 한다.

대안으로 검토했으나 채택하지 않음:
- **진짜 LSP 연동**: 정확하지만 프로세스 관리·언어별 서버로 PR이 지나치게 커지고,
  "유저는 자기 IDE에서 편집" 설계 철학과 충돌.
- **universal-ctags**: 언어 커버리지는 넓으나 외부 바이너리 번들/설치 의존성이 생겨
  Electron 배포·사용자 환경에서 깨질 수 있음.
- **정규식 휴리스틱**: 의존성 0이지만 정확도가 낮고 언어별 패턴 유지보수 부담.

## 아키텍처

```
[Renderer / Monaco]                         [Main process / Node]
 editor.goToDefinition (Cmd+B)      IPC       SymbolIndexService
 Monaco DefinitionProvider  ───────────────►  - web-tree-sitter (wasm) 파싱
 orca.goToDefinition action  ◄──────────────  - 워크트리별 심볼 테이블(def 위치)
 결과: 단일→점프 / 다중→peek           locations - 파일 변경 시 증분 갱신
```

- 파싱·인덱싱은 **메인 프로세스**(Node). Renderer는 "워크트리 W에서 심볼 `foo`의 정의
  위치들"만 IPC로 질의.
- 워크트리 루트별 인덱스 캐시. 기존 파일 워처(`useEditorExternalWatch` 계열 / main의
  워크트리 감시)에 훅해 변경 파일만 재파싱(증분 갱신).
- 최초 조회 시 lazy 인덱싱: 해당 워크트리가 아직 인덱싱 전이면 백그라운드로 스캔하고,
  준비되기 전 조회는 폴백 경로를 탄다.

## 컴포넌트 경계 (단위별 책임)

| 단위 | 위치 | 책임 | 의존 |
|---|---|---|---|
| `parser` | `src/main/symbol-index/parser.ts` | 언어별 tree-sitter 문법 로드 + 정의 노드 추출 쿼리. 입력(경로,내용)→출력 `SymbolDef[]` | web-tree-sitter |
| `index-store` | `src/main/symbol-index/index-store.ts` | 워크트리별 심볼 테이블 CRUD + name→정의 조회. 순수 자료구조 | 없음 |
| `service` | `src/main/symbol-index/service.ts` | 파일 스캔·워처 연동·IPC 핸들러 등록 | parser, index-store, ipc |
| `definition-provider` | `src/renderer/src/components/editor/monaco-definition-provider.ts` | Monaco `registerDefinitionProvider` + 커서 심볼 추출(기존 `getMonacoCodebaseSearchQuery` 로직 재사용) → IPC 질의 → `monaco.languages.Location[]` 변환 | ipc bridge |
| 통합 | `MonacoEditor.tsx` | 액션/프로바이더 등록 (기존 `orca.searchInFiles` 옆) | 위 |
| 키바인딩 | `src/shared/keybindings.ts` | `editor.goToDefinition` 액션 + 기본값(Cmd+B, F12) | 없음 |

`SymbolDef` 형태(초안): `{ name: string, kind: string, path: string, line: number, column: number }`

## 동작 흐름 & UX

1. 커서를 심볼에 두고 Cmd+B (또는 F12 / Cmd+클릭).
2. DefinitionProvider가 심볼명 추출 → 메인에 조회.
3. **정의 1개** → 해당 파일을 에디터 탭으로 열고 그 줄로 점프(기존 open-editor-tab
   스토어 액션 재사용; 구현 시 정확한 액션명 확정).
4. **정의 여러 개** → Monaco가 반환된 `Location[]`로 peek 위젯을 자동 표시.
5. **0개** → 조용히 폴백: 기존 `orca.searchInFiles` 경로로 위임(Search in Files 사이드바).

## 정확도 한계 & 폴백 (정직하게)

- 이름 기준 인덱스라 스코프/타입까지 구분하지 못한다. 동명이인은 후보 목록으로 노출.
- 이 한계를 코드 주석과 PR 설명에 명시(기존 `until Orca has semantic LSP references`
  톤과 일치).
- 지원 언어는 tree-sitter 문법 wasm 번들 크기를 고려해 주요 언어부터 시작하고, 언어별
  쿼리 파일(`.scm` 형태의 정의 추출 쿼리)로 점진 확장. 미지원 언어/미인덱스 상태는
  0건 폴백 경로로 자연스럽게 흡수.

## 테스트 전략

- `index-store`, `parser`, `definition-provider`(심볼 추출/Location 변환)는 순수 함수
  단위 테스트. 레포가 이미 `*.test.ts`를 촘촘히 두는 컨벤션이라 그대로 따른다.
- 언어별 픽스처 파일 골든 테스트: 정의 추출이 올바른 (path,line,col)을 내는지 검증.
- 폴백 경로(0건 → Search in Files) 테스트로 회귀 방지.
- 다중 정의 → `Location[]` 반환 형태 테스트(peek 위젯 트리거 계약 검증).

## 열린 항목 (구현 중 확정)

- 에디터 탭을 특정 경로+줄로 여는 정확한 스토어 액션/IPC 명칭.
- web-tree-sitter wasm 자산의 vite/electron 번들 방식(`?url`/asset 처리).
- 대형 워크트리 초기 인덱싱 성능 예산 및 파일 수 상한/제외 규칙(.gitignore 존중).
