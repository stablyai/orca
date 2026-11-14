# Tasks: Implementação de Workspace Popout Window no Orca

Convenções:

- Testes rodam com `pnpm vitest run --config config/vitest.config.ts <arquivo>`; antes do PR, `pnpm test:changed`, `pnpm tc:node`, `pnpm tc:web` e `pnpm lint`.
- Todos os critérios de aceite são estritamente verificáveis por testes automatizados (Vitest/fast-check) ou scripts de medição (SLOs).
- Referências de requisitos (REQ) e invariantes (INV) apontam para `specs/multi-window/spec.md` e `design.md`.

---

## Wave 0: Medição, Benchmarks e SLOs Iniciais

- [x] 0.1 Executar benchmark de latência de tecla p95 (`scripts/multi-window-slo/benchmark-keystroke-latency.mjs`).
  - Aceite: Script executado com 500 amostras; delta p95 comprovado em +7.86 ms (dentro do SLO de <= 16.00 ms).
- [x] 0.2 Executar benchmark de integridade de bytes e vazão sob carga (`scripts/multi-window-slo/benchmark-byte-integrity.mjs`).
  - Aceite: Stream de 10 MB com hash SHA-256 verificado idêntico entre produtor e consumidor; zero bytes perdidos a 356.99 MB/s.
- [x] 0.3 Executar benchmark de latência de destaque (`scripts/multi-window-slo/benchmark-tearoff-time.mjs`).
  - Aceite: 20 ciclos medidos; p50 = 179.0 ms, p95 = 191.3 ms (dentro do SLO de p95 <= 350 ms).
- [x] 0.4 Executar benchmark de memória e teste de vazamento de 20 ciclos (`scripts/multi-window-slo/benchmark-memory.mjs`).
  - Aceite: Overhead de memória medido em 5.7% (dentro do SLO de <= +15.0%); variação de heap do main em 3.9 KB após GC; zero listeners vazados.
- [x] 0.5 Modelar concorrência das 3 máquinas de estado no fast-check (`scratch/test-multi-window-model.js`).
  - Aceite: 1000 sequências aleatórias de operações executadas sem violação de INV-1 a INV-7.

---

## Wave 1: Fundação (Flag, Janela, Contratos e Guardas de IPC)

- [x] 1.1 Declarar `experimentalWorkspacePopout?: boolean` em `src/shared/global-settings-types.ts` (linha 453), padrão `false` em `src/shared/default-global-settings.ts` (linha 297), switch em `src/renderer/src/components/settings/advanced/ExperimentalPane.tsx` e busca em `experimental-search.ts`.
  - Aceite (Teste): `pnpm tc:node` e `pnpm tc:web` passam; teste de componente do `ExperimentalPane` confirma alternância da flag.
- [x] 1.2 Criar `src/shared/workspace-popout/workspace-popout-contract.ts` com os tipos e validadores estritos (`isWorkspacePopoutTarget`, limite de 4096 caracteres, rejeição de `isRemoteRuntimePtyId`).
  - Aceite (Teste): `workspace-popout-contract.test.ts` cobre payloads válidos, campos ausentes, strings vazias, strings com > 4096 caracteres e rejeição de PTYs remotos.
- [x] 1.3 Extrair `resolveRestoredBounds` de `src/main/window/dashboard-popout-window.ts` para `src/main/window/presentation/window-bounds-validation.ts`.
  - Aceite (Teste): Teste unitário cobre bounds válidos, abaixo do mínimo (480x360), fora da tela em todos os monitores e `null`.
- [x] 1.4 Adicionar `workspacePopoutBounds` em `src/shared/persisted-ui-state-types.ts`, `MainOwnedUIState` e `src/shared/wsl-move/wsl-move-ui-dispositions.ts`.
  - Aceite (Teste): `pnpm tc:node` e verificação de paridade de esquema passam sem erro.
- [x] 1.5 Implementar `src/main/window/workspace-popout-window.ts`: registro de popouts por `worktreeId`, máquina de estados idempotente, partição `orca-workspace-popout`, permissões negadas, listeners centralizados de módulo.
  - Aceite (Teste): `workspace-popout-window.test.ts` valida: INV-1 (1 janela por worktree em chamadas paralelas); `open` durante `closing` devolve `rejected: closing`; `dock` durante `closing` é no-op; concorrência de `dock` e `close` emite apenas um `stateChanged(open: false)`.
- [x] 1.6 Criar entry point `src/renderer/workspace-popout.html` e `src/renderer/src/workspace-popout.tsx`, registrando em `electron.vite.config.ts`.
  - Aceite (Teste): `pnpm build` gera o HTML no pacote; teste estático garante zero imports de `syncWindowGraph` e `session.set/patch` no bundle da satélite.
- [x] 1.7 Implementar `src/main/ipc/workspace-popout.ts` com os canais de controle (`open`, `publishTarget`, `dock`, `list`, `getTarget`).
  - Aceite (Teste): `workspace-popout-ipc.test.ts` valida cada canal com remetente autorizado e rejeita remetentes não confiáveis, flag desativada e payloads malformados sem lançar exceções.
- [x] 1.8 Encerrar satélites com a janela principal (`createMainWindow.ts:240-242`) e ao desativar a flag experimental.
  - Aceite (Teste): Teste simulando `mainWindow.emit('closed')` confirma chamada `close()` em todas as satélites registradas.

---

## Wave 2: Transporte de Terminal, Guardas de Sessão e Grafo

- [x] 2.1 Estender `isTerminalPreviewRenderer` (`src/main/ipc/terminal-preview.ts:22-24`) para incluir `isWorkspacePopoutRenderer(sender)` e prefixo `workspace-popout` na chave de visualizador.
  - Aceite (Teste): `terminal-preview.test.ts` valida que `connect`, `input`, `fit`, `ack` e `unsubscribe` aceitam a satélite e recusam remetentes não autorizados.
- [x] 2.2 Testar a garantia de titularidade exclusiva de grid no `RemoteDesktopTerminalFloor`: com a satélite dona, eventos `pty:resize` da janela principal são suprimidos e salvos como `hostReclaimTarget` (`resize-visibility.ts:47-54`).
  - Aceite (Teste): Teste unitário prova INV-2 sem alterar o `FitAddon` da janela principal.
- [x] 2.3 Montar `AgentTerminalPreview` na satélite com o alvo de `workspacePopout:getTarget`, suportando remontagem reativa em `workspacePopout:target` e `workspacePopout:resumed`.
  - Aceite (Teste): Teste de componente prova que `resumed` dispara reconexão limpa (`connect` + `unsubscribe` anterior) e `focus` da janela força re-reivindicação de grid (`fit`).
- [x] 2.4 Backoff exponencial para reconexão sob saturação (substituindo retry fixo de 150 ms por backoff até 2 s e alerta após 10 tentativas).
  - Aceite (Teste): Teste com fake timers prova intervalos crescentes e renderização do banner na 10ª tentativa.
- [x] 2.5 Habilitar copiar, colar e selecionar tudo para a satélite em `src/main/window/clipboard/clipboard-ipc-sender-trust.ts:19` e `src/main/ipc/ui.ts:113-116`.
  - Aceite (Teste): Teste de autorização de remetente passa para a satélite.
- [x] 2.6 Guardas de segurança de Sessão e Grafo (STRIDE):
  - Recusar `session:set`, `session:patch` e `session:close-terminal-surface` vindos da satélite (`src/main/ipc/session.ts:50-87`).
  - Recusar `runtime:syncWindowGraph` vindo da satélite (`src/main/ipc/runtime.ts:52-66`), inclusive quando `authoritativeWindowId` for `null` durante reload da janela principal.
  - Aceite (Teste): Testes unitários provam INV-4 e INV-5: invocações maliciosas da satélite são sumariamente bloqueadas no IPC.

---

## Wave 3: Blindagem de Plataforma e Resiliência

- [x] 3.1 Tratamento de remoção de monitores com `screen.on('display-removed')` e `screen.on('display-metrics-changed')` (apenas em X11 e macOS; sob Wayland, delega ao compositor).
  - Aceite (Teste): Teste unitário com `screen` mockado traz janelas fora de tela para o monitor primário sob X11/macOS; contagem de listeners volta a zero ao fechar as janelas.
- [x] 3.2 Sleep/Wake do sistema via `powerMonitor.on('resume')` emitindo `workspacePopout:resumed` para todas as satélites vivas.
  - Aceite (Teste): Teste confirma envio para todas as instâncias vivas e zero listeners quando não há satélites.
- [x] 3.3 Recuperação contra crash de processo renderer (`render-process-gone`): até 2 reloads em 60 s; na 3ª queda fecha com motivo `crashed` e devolve a aba à janela principal.
  - Aceite (Teste): Teste com relógio simulado confirma 2 reloads, fechamento na 3ª queda e reset do contador após 60 s.
- [x] 3.4 Reconciliação do estado do renderer principal após reload através de `workspacePopout:list`.
  - Aceite (Teste): Teste de store no renderer reconstrói as abas marcadas como destacadas a partir da resposta de `list`.

---

## Wave 4: Interface do Usuário (Destaque e Reacoplamento)

- [x] 4.1 Ação "Mover para Nova Janela" no menu de contexto da aba e botão no `TerminalTitlebarTabs.tsx`, visível apenas com a flag ativada e PTY local. A aba permanece no modelo e publicada no grafo; a área visual mostra o placeholder "Aberto em outra janela" com botão de retorno.
  - Aceite (Teste): Teste de componente confirma visibilidade condicional; clique invoca `workspacePopout:open`; folha da aba permanece no grafo publicado pelo `syncWindowGraph`.
- [x] 4.2 Botão "Reacoplar à Janela Principal" na satélite. Interceptação de `Cmd+W` / `Ctrl+W` (`tab.close`) no `before-input-event` da satélite no main process, convertendo em dock e prevenindo consumo pelo protocolo Kitty Keyboard.
  - Aceite (Teste): Teste do main confirma interceptação da tecla, chamada de `dock()` e ausência de bytes trafegados para o PTY.
- [x] 4.3 Definição de atalho configurável para destacar terminal (ex: `terminal.popOut`) em `src/shared/keybindings/definitions-core-*.ts`.
  - Aceite (Teste): Teste de paridade e ausência de conflitos de atalhos passa em `pnpm test`.

---

## Wave 5: Verificação Fim-a-Fim e Portões de Confiabilidade

- [x] 5.1 Teste de vazamento automatizado (20 ciclos de `open` + `dock`):
  - Aceite (INV-3): Listener counts em `app`, `screen`, `powerMonitor` e `mainI18n` retornam estritamente ao valor inicial; zero inscritos restantes em `hasRawTerminalViewSubscriber` e `hasViewers`.
- [x] 5.2 Teste automatizado de sobrevivência de PID (INV-6):
  - Aceite: O PID retornado antes de destacar, durante e após o dock permanece estritamente idêntico.
- [ ] 5.3 Validação interativa completa no app (`pnpm dev` com flag ligada):
  - Executar Claude Code com prompts `y/n`, comandos interativos (`vim`, `htop`), colagem multilinha.
  - Verificar saída de `orca terminal list --json` antes, durante e após o destaque (INV-5).
  - Validar desconexão de monitor e recuperação de sleep/wake.
  - Aceite: Checklist preenchido com evidências visuais e logs na Issue mãe.
- [ ] 5.4 Auditoria final de portões de qualidade:
  - Aceite: `pnpm check:changed` e `pnpm lint` passando com zero erros.
