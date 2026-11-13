# Tasks: Implementação de Workspace Popout Window no Orca

## Wave 1: Fundação do Workspace Popout Window (Shell & Segurança)
- [ ] 1.1 Declarar flag de configuração `experimentalWorkspacePopout` (default `false`) no schema global (`src/shared/settings.ts`) e no painel experimental (`ExperimentalPane.tsx`).
- [ ] 1.2 Implementar `src/main/window/workspace-popout-window.ts` com gerenciamento de bounds salvos (`resolveRestoredBounds`) e partição isolada (`orca-workspace-popout`).
- [ ] 1.3 Criar arquivos de entrada do renderer: `src/renderer/workspace-popout.html` e `src/renderer/src/workspace-popout.tsx`.
- [ ] 1.4 Registrar canais IPC em `src/main/ipc/workspace-popout.ts` para abertura, fechamento e notificação de estado.
- [ ] 1.5 Escrever testes unitários em Vitest para `workspace-popout-window.test.ts`.

## Wave 2: Interatividade do Terminal & Consumer Handover
- [ ] 2.1 Conectar a visualização do terminal popout ao subsistema `terminalPreview` (`src/main/ipc/terminal-preview.ts`).
- [ ] 2.2 Integrar `openStandaloneTerminal` com full input capture (`useAppMenuPaste`, `preview-terminal-shortcuts`).
- [ ] 2.3 Garantir exclusividade de redimensionamento (`FitAddon` suspenso na Janela Principal enquanto a aba estiver destacada) para evitar tempestades de `SIGWINCH`.
- [ ] 2.4 Validar o handshake do buffer de replay com suporte a flags do Kitty Keyboard (`preview-terminal-snapshot-replay.ts`).
- [ ] 2.5 Testar digitação interativa (Vim, Htop, Claude Code prompts `y/n`).

## Wave 3: Blindagem de Hardware e SO (Pass 3 Shields)
- [ ] 3.1 Registrar listener `screen.on('display-removed')` e `screen.on('display-metrics-changed')` para auto-repatriação caso o cabo HDMI/Thunderbolt seja desplugado.
- [ ] 3.2 Conectar `powerMonitor.on('resume')` na popout window para reidratação e recálculo de escala xterm após sleep/wake do macOS.
- [ ] 3.3 Adicionar listener `webContents.on('render-process-gone')` para proteção contra crash de GPU/OOM com recarregamento gracioso.
- [ ] 3.4 Validar integridade contínua do `OrcaRuntimeService` (garantindo que `orca worktree ps` e Mobile continuam listando os agentes).

## Wave 4: UI/UX de Destaque (Tear-Off) e Reacoplamento (Dock-Back)
- [ ] 4.1 Adicionar botão de Pop-out na barra de abas (`TerminalTitlebarTabs`) e opção *"Mover para Nova Janela"* no menu de contexto.
- [ ] 4.2 Adicionar botão *"Reacoplar à Janela Principal"* no topo da Popout Window.
- [ ] 4.3 Configurar atalho de teclado global do aplicativo (`Mod+Shift+P` / `Cmd+Shift+P` no macOS) para destacar o workspace ativo.
- [ ] 4.4 Realizar teste de estresse de longa duração com múltiplos agentes compilando em paralelo em ambos os monitores.
