# Tasks: Implementação de Multi-Window & Tab Tear-Off no Orca

## Wave 1: Fundação & Isolamento (Default-Off Guard)
- [ ] 1.1 Adicionar configuração experimental `experimentalMultiWindow` (padrão `false`) em `src/shared/settings.ts` e `src/renderer/src/components/settings/ExperimentalPane.tsx`.
- [ ] 1.2 Implementar `src/main/window/main-window-registry.ts` para registrar instâncias de `BrowserWindow` e exportar `liveMainWindows()`.
- [ ] 1.3 Refatorar `src/main/ipc/ui.ts` para broadcastar `ui:stateChanged` a todas as janelas do `liveMainWindows()`, eliminando o gargalo de `trustedUIRendererWebContentsId`.
- [ ] 1.4 Adicionar testes unitários em Vitest para `main-window-registry.test.ts`.

## Wave 2: Janelas Secundárias & Roteamento de PTY
- [ ] 2.1 Implementar `src/main/window/secondary-main-window.ts` com cálculo de bounds cascateados (`cascadedBounds()`) e marcação `isSecondaryWindow`.
- [ ] 2.2 Implementar `src/main/ipc/pty/delivery/pty-owner-routing.ts` para interceptar canais de claim (`pty:spawn`, `pty:write`, `pty:resize`) e rotear `pty:data` pelo dono.
- [ ] 2.3 Conectar o wrapper `withPtyOwnerTracking` no `src/main/ipc/pty-host-bindings.ts`.
- [ ] 2.4 Registrar o item de menu `File > New Window` (`Mod+Shift+N`) em `src/main/menu/app-menu-file.ts` condicionado a `experimentalMultiWindow`.
- [ ] 2.5 Proteger `src/renderer/src/app-shell/use-app-session-persistence.ts` com `isSecondaryWindow` para evitar sobrescrita destrutiva do `session.json`.
- [ ] 2.6 Executar suite de testes do PTY (`pnpm exec vitest run src/main/ipc/pty.test.ts`).

## Wave 3: Composite Runtime Graph & Visibilidade CLI/Mobile
- [ ] 3.1 Refatorar `OrcaRuntimeService` (`src/main/runtime/orca-runtime.ts`) para suportar múltiplos grafos de janela (`windowGraphs: Map<number, WindowGraph>`).
- [ ] 3.2 Implementar união de grafos (`mergeCompositeGraphs`) em `src/main/runtime/session-graph/`.
- [ ] 3.3 Atualizar `src/main/ipc/runtime.ts` para aceitar `syncWindowGraph` da janela secundária sem lançar exceção de autoridade.
- [ ] 3.4 Validar que `orca worktree ps` lista os agentes em execução na janela secundária.
- [ ] 3.5 Atualizar testes de autoridade em `src/main/runtime/orca-runtime-tests/window-authority.spec.ts`.

## Wave 4: Mecânica de Tab Tear-Off & Ação de Menu de Contexto
- [ ] 4.1 Adicionar canal IPC `window:detachTab` em `src/main/ipc/window-actions.ts`.
- [ ] 4.2 Adicionar opção de menu de contexto nas abas do workspace no frontend: *"Mover para Nova Janela"*.
- [ ] 4.3 Implementar a transição sem perda de sessão: Janela 1 desmonta aba -> Janela 2 cria/carrega workspace -> PTY owner é transferido.
- [ ] 4.4 Testar fluxo completo com 2 monitores e múltiplos agentes rodando em paralelo.
