# Tasks: Implementação de Multi-Window & Tab Tear-Off no Orca

## Wave 1: Fundação Segura (Default-Off Guard & Registry)
- [ ] 1.1 Declarar a flag experimental `experimentalMultiWindow` (default `false`) no schema de configurações do Orca (`src/shared/settings.ts`) e no painel experimental (`ExperimentalPane.tsx`).
- [ ] 1.2 Implementar `src/main/window/main-window-registry.ts` com suporte a `anchor` e `satellite` windows e ciclo de vida seguro.
- [ ] 1.3 Refatorar `src/main/ipc/ui.ts` para broadcastar `ui:stateChanged` a todas as janelas do `liveMainWindows()`, eliminando o gargalo de ID único.
- [ ] 1.4 Escrever testes unitários em Vitest para `main-window-registry.test.ts`.

## Wave 2: Consumer Handover de PTY & Janela Satélite
- [ ] 2.1 Implementar `src/main/window/secondary-main-window.ts` com cálculo de bounds cascateados e papel de janela satélite (`?orcaWindowRole=satellite`).
- [ ] 2.2 Implementar `src/main/ipc/pty/delivery/pty-owner-routing.ts` com suporte a troca de consumidor (Consumer Handover) e replay do buffer de terminal.
- [ ] 2.3 Implementar filtro de exclusividade no canal `pty:resize` para impedir concorrência de resoluções de tela.
- [ ] 2.4 Integrar `withPtyOwnerTracking` ao `src/main/ipc/pty-host-bindings.ts`.
- [ ] 2.5 Adicionar `File > New Window` (`Mod+Shift+N`) no menu nativo (`app-menu-file.ts`), habilitado apenas sob `experimentalMultiWindow`.
- [ ] 2.6 Bloquear autosave destrutivo no `use-app-session-persistence.ts` para janelas satélites.
- [ ] 2.7 Executar e validar suite de testes de PTY (`pnpm exec vitest run src/main/ipc/pty.test.ts`).

## Wave 3: Composite Runtime Graph (Visibilidade CLI, Mobile & Skills)
- [ ] 3.1 Atualizar `OrcaRuntimeService` (`src/main/runtime/orca-runtime.ts`) para compor grafos de múltiplas janelas em `windowGraphs: Map<number, WindowGraph>`.
- [ ] 3.2 Implementar função `getCompositeGraph` unindo tabs e leaves de todas as janelas ativas.
- [ ] 3.3 Atualizar `src/main/ipc/runtime.ts` para aceitar slices de grafo das janelas satélites sem exceção de autoridade.
- [ ] 3.4 Validar que `orca worktree ps` e a API WebSocket do Mobile listam agentes rodando na janela satélite.
- [ ] 3.5 Ajustar a suite de testes `src/main/runtime/orca-runtime-tests/window-authority.spec.ts` para cobrir o modelo composite.

## Wave 4: Tear-Off & Dock-Back na Interface (UI/UX)
- [ ] 4.1 Criar canal IPC `window:detachWorkspace` e `window:dockWorkspace` no processo Main.
- [ ] 4.2 Adicionar opção no menu de contexto das abas do workspace no frontend: *"Mover para Nova Janela"*.
- [ ] 4.3 Adicionar botão de reacoplamento na janela satélite: *"Reacoplar à Janela Principal"*.
- [ ] 4.4 Testar o fluxo de transição com um agente ativo executando comandos longos (ex: build ou geração de código) garantindo zero interrupção de processo.
