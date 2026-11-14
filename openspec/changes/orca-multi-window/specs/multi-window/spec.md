# Spec: Workspace Popout Window

> Requisitos auditados contra o código, histórico do Git e medições reproduzíveis em 2026-11-13.
> Contratos detalhados em design.md, seção 4; FMEA na seção 9; invariantes INV-1 a INV-7 na seção 10.
> Todos os critérios de aceite são verificados por testes automatizados (Vitest/fast-check) ou scripts de benchmark com SLOs numéricos.

---

## Requisitos Funcionais & Critérios de Aceite Automatizados

### REQ-WPO-01: Flag de Segurança Experimental

- **Descrição:** A funcionalidade DEVE depender de `experimentalWorkspacePopout` (padrão `false`), declarada em `src/shared/global-settings-types.ts` e com padrão em `src/shared/default-global-settings.ts`.
- **Critério de Aceite (Automatizado):**
  - `workspace-popout-ipc.test.ts`: Com a flag `false`, qualquer invocação de `workspacePopout:open`, `workspacePopout:dock` ou `workspacePopout:list` devolve `{ status: 'rejected', reason: 'flag-disabled' }` sem instanciar `BrowserWindow`.
  - `workspace-popout-settings.test.ts`: Desligar a flag com 2 satélites abertas dispara `closeAllWorkspacePopouts('flag-disabled')`, fecha as janelas e emite `workspacePopout:stateChanged({ open: false, reason: 'flag-disabled' })` para cada worktree.

### REQ-WPO-02: Instanciação e Gestão de Janela Satélite

- **Descrição:** O sistema DEVE abrir no máximo uma `BrowserWindow` satélite por `worktreeId` (`workspace-popout-window.ts`). Os bounds DEVEM ser validados contra a geometria real dos monitores.
- **Critérios de Aceite (Automatizados e Medidos):**
  - `workspace-popout-window.test.ts` (INV-1): `workspacePopout:open` chamado sequencialmente ou via `Promise.all` (5 chamadas concorrentes) para o mesmo `worktreeId` instancia exatamente 1 `BrowserWindow` e devolve `{ status: 'focused' }` para as chamadas concorrentes.
  - `window-bounds-validation.test.ts`: Bounds persistidos sem ao menos 240×180 px visíveis em algum monitor ativo são descartados por `resolveRestoredBounds`, revertendo para o padrão 960×720 centralizado.
  - `benchmark-memory.mjs` (SLO de Memória): O processo renderer da satélite em repouso (após 1000 linhas de scrollback) consome no máximo o valor do `AgentTerminalDialog` da popout do dashboard + 15% (medido via `app.getAppMetrics()` / `process.getProcessMemoryInfo()`).
  - `benchmark-tearoff-time.mjs` (SLO de Latência de Destaque): O tempo decorrido entre `workspacePopout:open` e o primeiro frame pintado no xterm cumpre p95 ≤ 350 ms (warm) e p95 ≤ 600 ms (cold launch).

### REQ-WPO-03: Zero Interrupção de Processos de Agente (PTY Survival)

- **Descrição:** Abrir, reacoplar, fechar ou derrubar a satélite NÃO DEVE reiniciar, desanexar nem enviar sinais de terminação ao processo filho do agente nem ao PTY.
- **Critérios de Aceite (Automatizados):**
  - `pty-process-survival.test.ts` (INV-6): O PID retornado por `runtime.getTerminalProcessId(ptyId)` permanece estritamente idêntico antes do `open`, durante a vida da satélite, após crash do renderer (`render-process-gone`) e após `dock`.
  - `workspace-popout-dock.test.ts` (INV-7): Nenhum caminho de `dock`, `closeWindow` ou `before-quit` invoca `session:close-terminal-surface` ou `markPtyStopRequested`.

### REQ-WPO-04: Transporte de Terminal Interativo e Arbitragem de Grid

- **Descrição:** A satélite exibe saída via `terminalPreview:connect` e `terminalPreview:data`, envia digitação por `terminalPreview:input` e arbitra dimensões por `terminalPreview:fit` via `RemoteDesktopTerminalFloor`.
- **Critérios de Aceite (Automatizados e Medidos):**
  - `benchmark-byte-integrity.mjs` (SLO de Integridade): Sob carga de 10 MB a 25 MB/s, 0 bytes são perdidos ou corrompidos; o hash SHA-256 do produtor coincide 100% com o do consumidor na satélite.
  - `benchmark-keystroke-latency.mjs` (SLO de Latência de Tecla): A latência p95 de eco de tecla na satélite não excede a da janela principal em mais de 16,00 ms (teto do intervalo de batch de 8 ms + overhead IPC).
  - `terminal-preview-snapshot.test.ts`: A fronteira entre snapshot e stream emite todos os chunks em ordem sequencial com `seq`.
  - `remote-desktop-terminal-floor.test.ts` (INV-2): Com a satélite dona do grid, eventos `pty:resize` vindos do renderer principal são silenciados no main process e armazenados apenas como `hostReclaimTarget` (`resize-visibility.ts:47-54`).
  - `AgentTerminalPreview.focus.test.tsx`: Ao receber o evento `focus`, a satélite força uma chamada `terminalPreview.fit` imediata para retomar a titularidade do grid após digitação no host.

### REQ-WPO-05: Integridade Absoluta do Grafo de Sessão (Anti-Hijack)

- **Descrição:** A janela principal é a ÚNICA autoridade publicadora no `OrcaRuntimeService`. A aba destacada permanece publicada no grafo pela janela principal, sem alterações na visibilidade para CLI e Mobile.
- **Critérios de Aceite (Automatizados):**
  - `runtime-graph-guard.test.ts` (INV-5): Chamadas a `runtime:syncWindowGraph` originadas de um `webContents` de satélite são bloqueadas antes de atingir o runtime com erro imediato.
  - `session-graph-reload-race.test.ts`: Durante o reload da janela principal (quando `authoritativeWindowId` é temporariamente `null`), uma chamada simulada da satélite a `syncWindowGraph` é terminantemente recusada, impedindo o sequestro do grafo.
  - `cli-graph-parity.test.ts`: A saída de `orca terminal list --json` lista o handle e o `ptyId` com o mesmo status antes, durante e depois da satélite estar aberta.

### REQ-WPO-06: Blindagem Contra Escrita Indevida de Sessão (STRIDE)

- **Descrição:** O processo principal DEVE restringir a mutação do arquivo `session.json` e encerramento de abas exclusivamente à janela principal autorizada.
- **Critérios de Aceite (Automatizados):**
  - `session-ipc-sender-guard.test.ts` (INV-4): Invocações de `session:set`, `session:patch` e `session:close-terminal-surface` vindas do `webContents` de uma satélite são descartadas sem alterar o store de persistência e sem lançar exceções não tratadas.

### REQ-WPO-07: Reacoplamento Seguro e Resolução de Concorrência

- **Descrição:** O desenvolvedor pode reacoplar via botão de UI ou atalho de teclado (`Cmd+W` / `Ctrl+W` / ação `tab.close`). Concorrências entre fechamento nativo e dock DEVEM ser resolvidas deterministicamente.
- **Critérios de Aceite (Automatizados):**
  - `dock-concurrency.test.ts`: Disparo simultâneo de clique em "Reacoplar" e fechamento de janela do SO emite exatamente um único evento `workspacePopout:stateChanged({ open: false, reason: 'docked' })`.
  - `dock-kitty-keyboard.test.ts`: Com o protocolo Kitty Keyboard ativado no terminal, `before-input-event` intercepta `Cmd+W` / `Ctrl+W` no main process antes que o xterm converta a combinação em CSI u, acionando o dock sem vazar bytes para o PTY.
  - `workspace-popout-leak.test.ts` (INV-3): Após 20 ciclos de `open` e `dock`, a contagem de listeners em `app`, `screen`, `powerMonitor` e `mainI18n` retorna estritamente ao valor inicial de repouso (diferença zero), e a variação de heap do main após GC é < 512 KB.

### REQ-WPO-08: Tratamento de Falhas e Ciclo de Vida

- **Descrição:** Quedas do renderer da satélite, suspensão do sistema operacional (sleep/wake) e fechamento da janela principal devem ser tratados de forma resiliente.
- **Critérios de Aceite (Automatizados):**
  - `satellite-crash-recovery.test.ts`: O crash do renderer (`render-process-gone`) provoca reload automático até 2 vezes em uma janela de 60 s. Na 3ª queda, a janela é fechada com motivo `crashed` e a aba retorna automaticamente à janela principal.
  - `power-monitor-resume.test.ts`: Ao receber `powerMonitor.on('resume')`, o main envia `workspacePopout:resumed` para todas as satélites vivas, provocando reconexão limpa do stream de terminal.
  - `main-window-close.test.ts`: Fechar a janela principal fecha em cascata todas as satélites abertas com o motivo `main-closed`.

---

## Restrições e Limitações Plataforma-Específicas (Não Prometidas na v1)

| Plataforma            | Limitação Técnica Inerente                                                                                                                                 | Tratamento na v1                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Linux Wayland**     | Protocolo `xdg-shell` proíbe aplicações de definir coordenadas absolutas (`x`, `y`) de janelas top-level. `window.setPosition` é ignorado pelo compositor. | A persistência de coordenadas `(x, y)` e a repatriação manual em `display-removed` são desativadas sob Wayland; o posicionamento é delegado integralmente ao compositor. |
| **macOS Spaces**      | Janelas em Spaces de tela cheia nativa isolam outros processos; criar janelas sem flags de coleção força animação de troca de Space.                       | Janelas satélite abrem no espaço de desktop comum e não seguem Spaces em tela cheia na v1 (requer flags auxiliares na v2).                                               |
| **Windows Mixed-DPI** | Monitores com fatores de escala diferentes (ex: 150% e 100%) disparam eventos `WM_DPICHANGED` com dimensões intermediárias instáveis durante o arrasto.    | O recálculo de grid (`terminalPreview:fit`) durante transições de DPI possui debounce de 250 ms para evitar tempestades de `SIGWINCH` e distorção de caracteres.         |
