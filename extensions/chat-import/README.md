# Orca Chat Import (dev)

ChatGPT · Claude · Gemini 웹 대화를 Orca의 AI Vault로 가져오는 개발용 Chrome 확장입니다.

## 아키텍처

확장(content script가 각 사이트 API를 읽음) → background(native messaging) →
`orca chat-import-host`(호스트명 `com.orca.chatimport`) → `chats.db` → AI Vault.

## 설치·사용 절차

1. `chrome://extensions` 접속 → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드합니다** 클릭 →
   이 저장소의 `extensions/chat-import/` 폴더 선택.
2. 로드된 확장 카드에 표시되는 **ID를 복사**해 둡니다.
3. 터미널에서 다음 명령으로 네이티브 메시징 호스트를 등록합니다.

   ```bash
   orca chat-import-host install --extension-id <복사한 ID> [--browser chrome]
   ```

   `--browser`는 `chrome`(기본값) · `edge` · `brave` · `chromium` 중 선택할 수 있습니다.
   설치가 끝나면 `chrome://extensions`에서 확장을 **새로고침**해 새 호스트를 인식시켜 주세요.
4. chatgpt.com / claude.ai / gemini.google.com 중 로그인된 사이트 탭을 열고, 확장 아이콘을 클릭한 뒤
   **동기화** 버튼을 누릅니다.
5. Orca 앱의 AI Vault → **Agent 세션 기록** 패널에 해당 웹 대화가 읽기전용으로 표시됩니다.

## M1 범위

- 텍스트 대화만 가져옵니다. 첨부파일·이미지는 이번 범위에서 제외됩니다.
- Chrome을 우선 지원하며, Edge/Brave/Chromium은 설치 시 `--browser` 옵션으로 지정합니다.
- 확장 ID는 로드한 폴더 경로 기반으로 생성되므로, 확장을 다시 로드하면 ID가 바뀔 수 있습니다.
  ID가 바뀌면 3단계의 `install` 명령을 새 ID로 다시 실행해야 합니다.
