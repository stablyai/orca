# Proposal: Suporte a Segundo Monitor via Workspace Popout Window

> Status: proposta auditada contra o código (auditoria arquitetural de 2026-11-13). Nada aqui está homologado; os números e garantias que dependem de medição estão marcados como hipótese até a Wave 0 e o smoke test da Wave 5 rodarem.

## Contexto e Motivação

O **Orca** ([stablyai/orca](https://github.com/stablyai/orca)) é um ambiente de desenvolvimento agentico (ADE) para paralelizar agentes (Claude Code, Codex, Antigravity) em worktrees Git isolados.

O app impõe uma janela principal única. Quem usa dois monitores ou vários desktops virtuais (macOS Spaces / Windows Desktops) não consegue tirar um terminal de agente da janela principal para acompanhá-lo em outra tela.

Referências externas citadas pela comunidade (não verificadas nesta auditoria, que olhou só o código do fork):

- **Issue #6074** (_[Feature]: Multiple windows_).
- **Issue #22167** (_Tear out floating workspaces into independent windows_).
- **Issue #28955** (_Move a terminal tab to its own window_).
- **PR #5329** (_Add experimental multi-window support_): tentativa de janelas simétricas completas, parada por complexidade.
- **Protótipo de Robert Crivat** ([Robert-Crivat/orca](https://github.com/Robert-Crivat/orca)): silenciava o grafo da janela 2.

---

## Por que não duplicar a janela principal (evidência no código)

1. **O runtime aceita um único publicador de grafo.** `admitWindowPublisher` lança erro quando outra janela publica (`src/main/runtime/session-graph/session-window-publisher.ts:24-29`). Uma segunda janela principal precisaria reescrever esse contrato.
2. **Sumir com uma aba do grafo estaciona o PTY.** Folhas que deixam de ser publicadas são marcadas com `markPtyColdParked` (`src/main/runtime/session-graph/session-window-graph.ts:181-187`), e os handles de CLI são invalidados.
3. **Builds empacotados confiam só no `webContents` registrado.** `isTrustedMainRendererSender` recusa qualquer outro documento quando não há `ELECTRON_RENDERER_URL` (`src/main/ipc/main-renderer-sender-trust.ts:14-18`).
4. **Já existe uma janela satélite com terminal interativo em produção.** A popout do dashboard (`src/main/window/dashboard-popout-window.ts:129-291`) usa o transporte `terminalPreview:*` (`src/main/ipc/terminal-preview.ts:88-254`), que tem snapshot com fronteira atômica, input, ack e disputa de grid.

O item 4 é o que viabiliza a proposta: o trabalho é estender um caminho que já existe, sem mexer no core do grafo.

---

## A solução proposta: "Workspace Popout Window"

1. **Janela principal como autoridade única.**
   - A janela principal continua sendo a única publicadora no `OrcaRuntimeService`.
   - A aba destacada **continua publicada no grafo pela janela principal, sem nenhum campo novo no contrato do grafo**. O estado "destacada" vive no store do renderer principal e no registro do main process (ver design.md, seção 4). Assim CLI (`orca worktree ps`, `orca terminal list`) e Orca Mobile não mudam.
2. **Janela satélite dedicada (`src/main/window/workspace-popout-window.ts`).**
   - No máximo uma por worktree, em partição em memória `orca-workspace-popout`, no mesmo molde da popout do dashboard (`dashboard-popout-window.ts:150-176`).
   - Consumo de memória: **hipótese a medir** (Wave 0). O valor de ~40 MB citado antes não tem medição no repositório e foi removido.
   - Não grava `session.json`. Hoje isso não é imposto pelo main (`src/main/ipc/session.ts:50-70` não valida o remetente), então a change inclui a guarda.
3. **Terminal por streaming.**
   - Saída: `TerminalPreviewOutputStream` (`src/main/ipc/terminal-preview-output-stream.ts:49`), que é **só saída**.
   - Entrada: `terminalPreview:input` -> `writeTerminalPreviewInput` (`src/main/ipc/terminal-preview.ts:164-176`, `src/main/runtime/terminal/layout/terminal-view-presence.ts:268-282`).
   - Grid: `terminalPreview:fit` -> `updateRemoteDesktopViewer` (`terminal-preview.ts:196-246`), arbitrado por `RemoteDesktopTerminalFloor`.
   - O PTY e o processo do agente continuam no host; a satélite é só mais um visualizador.
4. **UX de destaque e reacoplamento.**
   - Ação _"Mover para Nova Janela"_ no menu de contexto e na barra de abas (`src/renderer/src/components/TerminalTitlebarTabs.tsx`). Atalho padrão a decidir (ver questões abertas); `Mod+Shift+P` está livre nas definições atuais.
   - Botão _"Reacoplar à Janela Principal"_ na satélite.

## Escopo da v1

- **Dentro:** um terminal (um `ptyId`) por satélite, PTY local (não `remote-runtime`), macOS, Windows e Linux.
- **Fora até decisão do dono:** chat (`NativeChatView`) e diff (`EditorDiffFileSurface`) na satélite, PTYs de runtime remoto pareado, restauração automática da satélite no boot seguinte. Os motivos estão em design.md, seção 7.
