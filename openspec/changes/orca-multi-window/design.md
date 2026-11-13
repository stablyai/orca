# Design Document: Arquitetura Multi-Window & Tab Tear-Off no Orca

## Visão Geral da Arquitetura

O Orca opera como uma aplicação Electron com arquitetura distribuída:
1. **Processo Principal (Node.js/Electron Main):** Gerencia ciclo de vida, janelas nativas, IPC, SQLite (`state_5.sqlite`), processo PTY/orcad e orquestração de runtime.
2. **Processos de Renderização (Electron Renderers):** Cada `BrowserWindow` executa uma instância isolada do frontend React/Zustand.
3. **Runtime Service & Daemons:** Gerencia worktrees, catálogo de projetos, automações e comunicação com CLI/Mobile via WebSocket.

```mermaid
flowchart TD
    subgraph MainProcess ["Electron Main Process"]
        Registry["MainWindowRegistry\n(Window 1 & Window 2)"]
        UIBridge["sendToTrustedUIRenderer\n(Broadcast to all main windows)"]
        PTYRouter["pty-owner-routing\n(Maps ptyId -> Window Owner)"]
        Runtime["OrcaRuntimeService\n(Composite Graph: Map<WindowId, Graph>)"]
        Disk["Session Persistence Engine\n(Partitioned session by windowId)"]
    end

    subgraph Window1 ["Janela 1 (Monitor Principal)"]
        R1["Renderer React/Zustand"]
        W1["Worktree A (Agente 1)"]
    end

    subgraph Window2 ["Janela 2 (Segundo Monitor)"]
        R2["Renderer React/Zustand"]
        W2["Worktree B (Agente 2)"]
    end

    Registry --> Window1
    Registry --> Window2
    PTYRouter -->|pty:data / pty:resize| W1
    PTYRouter -->|pty:data / pty:resize| W2
    Window1 -->|syncWindowGraph(1)| Runtime
    Window2 -->|syncWindowGraph(2)| Runtime
    Runtime -->|Unified Graph| CLI["Orca CLI & Mobile"]
```

---

## Detalhamento dos 4 Pilares Arquiteturais

### 1. MainWindowRegistry & Ciclo de Vida do Electron

#### Problema Existente
* `src/main/ipc/ui.ts` possui uma variável escalar `let trustedUIRendererWebContentsId: number | null = null`.
* O `app.on('window-all-closed')` assume que qualquer fechamento de janela pode encerrar o aplicativo se não houver janelas secundárias formalmente registradas.

#### Solução
Criar `src/main/window/main-window-registry.ts`:
* Armazena instâncias de janelas em `liveMainWindows(): BrowserWindow[]`.
* Expõe helpers:
  * `registerMainWindow(window: BrowserWindow)`
  * `unregisterMainWindow(window: BrowserWindow)`
  * `isMainWindowWebContents(contents: WebContents): boolean`
  * `isSecondaryMainWindowWebContents(contents: WebContents): boolean`
* Atualiza `sendToTrustedUIRenderer` em `src/main/ipc/ui.ts` para iterar e enviar atualizações do store a **todas as janelas vivas**, evitando telas congeladas.
* O fechamento do app no macOS/Linux/Windows só ocorre quando `liveMainWindows().length === 0`.

---

### 2. PTY Owner Routing & Prevenção de Conflitos de Redimensionamento

#### Problema Existente
* O PTY emite `pty:data` e escuta `pty:resize` sem discernir qual tela está exibindo o terminal.
* Se duas telas com larguras diferentes (ex: 80 colunas vs 160 colunas) emitirem `pty:resize`, o buffer de texto do terminal xterm corrompe a formatação (wraps de linha erráticos e panes travados).

#### Solução
Criar `src/main/ipc/pty/delivery/pty-owner-routing.ts`:
* **Canais de reivindicação (Claiming Channels):** `pty:spawn`, `pty:write`, `pty:writeAccepted`, `pty:resize`.
* **Canais exclusivos do dono (Owner Only):** `pty:setActiveRendererPty`, `pty:setHiddenRendererPty`, `pty:terminalViewAttributes`.
* Quando a Janela 2 foca ou instancia um terminal, ela executa `notePtyOwner(ptyId, senderContents)`.
* O wrapper de IPC `withPtyOwnerTracking` filtra os eventos e entrega `pty:data` exclusivamente ao `webContents` registrado como proprietário daquele terminal.
* **Resultado:** Redimensionamentos na Janela 1 nunca afetam os terminais da Janela 2, eliminando os gargalos de concorrência observados no PR #5329.

---

### 3. Composite Window Graph no `OrcaRuntimeService`

#### Problema Existente
* O runtime trava com erro caso uma janela com ID diferente do `authoritativeWindowId` chame `syncWindowGraph()`.
* O protótipo prévio silenciava a Janela 2 (`if (isSecondary) return runtime.getStatus()`), gerando o efeito colateral crítico de deixar a CLI e o Orca Mobile cegos para os agentes rodando na Janela 2.

#### Solução
No `OrcaRuntimeService` (`src/main/runtime/orca-runtime.ts`):
* Mudar a autoridade escalar para um mapa de grafos:
  ```typescript
  private windowGraphs: Map<number, WindowGraph> = new Map();
  ```
* O método `syncWindowGraph(windowId: number, graph: WindowGraph)` armazena o slice reportado por cada janela.
* O método `getStatus()` e os endpoints expostos para a CLI e Mobile passam a computar a **união consolidada**:
  ```typescript
  export function mergeCompositeGraphs(graphs: Iterable<WindowGraph>): CompositeGraphSummary {
    const allTabs = [];
    const allLeaves = [];
    for (const g of graphs) {
      allTabs.push(...g.tabs);
      allLeaves.push(...g.leaves);
    }
    return { tabs: allTabs, leaves: allLeaves };
  }
  ```
* Cada janela é dona apenas do seu slice de workspaces/tabs, mas o ecossistema externo enxerga a totalidade dos agentes em execução.

---

### 4. Persistência de Sessão Particionada (`session.json`)

#### Problema Existente
* `useAppSessionPersistence.ts` no renderer escuta as mutações do Zustand e persiste o estado diretamente no arquivo central `session.json`.
* Ao abrir uma janela secundária vazia, ela faria o flush de uma lista de workspaces nula, apagando a sessão da janela principal.

#### Solução
* **Fase 1 (Proteção Imediata):** A Janela secundária recebe query param `?orcaWindowRole=secondary` e inicializa `isSecondaryWindow = true`. A persistência do arquivo central continua a cargo exclusivo da Janela Primária (`useAppSessionPersistence` retorna `noop` na janela secundária).
* **Fase 2 (Persistência Completa de Multi-Janela):** O schema do `session.json` é evoluído com retrocompatibilidade:
  ```json
  {
    "version": 2,
    "primaryWindow": { "bounds": {...}, "workspaces": ["ws-1"] },
    "secondaryWindows": [
      { "id": "win-2", "bounds": {...}, "workspaces": ["ws-2"] }
    ]
  }
  ```
* Ao reiniciar o Orca com a flag experimental ativada, o app reabre automaticamente ambas as janelas exatamente nos monitores e com os workspaces onde estavam.

---

### 5. Mecânica de "Tab Tear-Off" (Destaque de Aba)

Diferente do Google Chrome, onde o Chromium reparenta widgets C++ entre janelas nativas, no Electron cada janela é um processo V8 e React tree independente.

Para viabilizar o destaque de abas:
1. No menu de contexto de qualquer aba de chat/workspace/terminal:
   * Adiciona: **"Mover para Nova Janela"** (`contextMenu.ts`).
2. O renderer dispara:
   ```typescript
   window.api.window.detachTab({ tabId, workspaceKey });
   ```
3. O processo Main:
   * Cria a `BrowserWindow` secundária com coordenadas cascateadas no monitor adjacente.
   * Inicializa o renderer passando o `workspaceKey` de destino.
   * Invoca `notePtyOwner(terminalId, newWindow.webContents)`.
4. A Janela 1 desmonta o componente da aba; a Janela 2 monta o componente e assume o streaming do PTY existente.
5. **Resultado:** O agente continua rodando ininterruptamente, sem perda de histórico, sem reinicialização de processo.
