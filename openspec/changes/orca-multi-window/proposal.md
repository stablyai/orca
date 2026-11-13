# Proposal: Suporte Nativo a Múltiplas Janelas e Destaque de Abas (Anchor-Satellite Architecture)

## Contexto e Motivação

O **Orca** ([stablyai/orca](https://github.com/stablyai/orca)) consolidou-se como o ADE (Agentic Development Environment) de referência para orquestração paralela de agentes de código (Claude Code, Codex, Antigravity) isolados por Git worktrees.

No entanto, o app impõe uma **única janela desktop no Electron** com `singleInstanceLock` rígido. Usuários que utilizam dois ou mais monitores ou múltiplos desktops virtuais (macOS Spaces / Windows Desktops) não conseguem separar abas de trabalho em telas distintas.

Essa limitação é a mais solicitada e debatida pela comunidade:
* **Issue #6074** (*[Feature]: Multiple windows*): Aberta há 4 meses com centenas de reações e solicitações diárias de suporte a múltiplos monitores.
* **Issue #22167** (*Tear out floating workspaces into independent windows*): Demanda por destacar terminais flutuantes para que telas cheias de diff/browser não cubram os agentes.
* **Issue #28955** (*Move a terminal tab to its own window*): Desejo de clicar em uma aba de chat/terminal e abri-la no monitor secundário.
* **PR #5329** (*Add experimental multi-window support* por Brennan Benson): PR oficial dos mantenedores com mais de 12.500 linhas que tentou tornar todas as janelas "iguais" de uma só vez, gerando complexidade excessiva, timeouts em testes de escala PTY e estagnação há 5 meses (~6.000 commits defasado da `main`).
* **Protótipo Comunitário de Robert Crivat** ([Robert-Crivat/orca](https://github.com/Robert-Crivat/orca)): Demonstrou viabilidade em ~359 linhas cirúrgicas, mas silenciou o grafo da janela 2 (`if (isSecondary) return`), deixando a CLI (`orca worktree ps`), o Orca Mobile e as Skills completamente cegos aos agentes secundários, além de não implementar o destaque/reacoplamento de abas.

---

## O Problema Sob a Ótica Crítica ("Se fosse fácil, já teriam feito")

A investigação minuciosa do código-fonte revelou por que o time da Stably AI travou nessa implementação:

1. **Gargalo de Autoridade no Runtime:** O `src/main/ipc/ui.ts` e `OrcaRuntimeService` foram construídos sob a premissa de um único publicador de grafo (`trustedUIRendererWebContentsId`). Se duas janelas publicarem, ocorre colisão de autoridade.
2. **Disputa de Resolução de Tela no PTY (xterm buffer wrap):** Se a Janela 1 estiver num monitor 4K (160 colunas) e a Janela 2 num laptop (80 colunas), disparar redimensionamentos concorrentes para o mesmo processo bash/zsh corrompe a formatação do terminal.
3. **Risco de Morte do Processo do Agente:** Em implementações ingênuas, destacar uma aba destrói o componente React e recria o PTY, o que mataria o processo do Claude Code ou Codex no meio de uma compilação ou raciocínio.
4. **Sobrescrita Destrutiva de Sessão no Disco:** O frontend React grava periodicamente em `userData/session.json`. Uma janela secundária recém-aberta (vazia) pode sobrescrever o arquivo e apagar do disco as abas da janela principal.

---

## A Solução Proposta: Modelo "Janela Âncora + Janelas Satélites"

Em vez de criar um monólito de 12 mil linhas tentando fazer janelas perfeitamente simétricas com concorrência complexa, esta proposta adota a **Abordagem de Simplicidade Máxima com Segurança Total**:

1. **Janela Âncora (Primary Window):**
   * Mantém o ciclo de vida global do Electron, menus do sistema, diálogos de encerramento e consolidação da persistência de sessão.
2. **Janelas Satélites (Secondary/Satellite Windows):**
   * Janelas leves dedicadas a exibir worktrees/chats/terminais destacados.
   * Não disputam autoridade global de encerramento do app.
3. **Consumer Handover (Zero Interrupção de Agentes):**
   * O processo PTY/Node do agente continua rodando no processo Main/Daemon ininterruptamente.
   * Ao destacar a aba, a Janela 1 apenas cancela a subscrição de tela (`unsubscribe`); a Janela 2 monta o xterm, conecta no `ptyId` já ativo e recebe o replay do buffer.
   * **O agente nunca percebe que mudou de tela. Zero perda de processo, zero perda de histórico.**
4. **Exclusividade de Visualização do Terminal:**
   * Um terminal ativo é exibido exclusivamente em uma janela por vez. Apenas a janela onde o terminal está visível tem o direito de enviar `pty:resize`, eliminando qualquer conflito de colunas.
5. **Composite Window Graph:**
   * O runtime no Main process mantém um mapa por workspace (`Map<windowId, WindowGraph>`) e expõe a **união consolidada** dos agentes para a CLI do Orca, o Orca Mobile e as Skills.
6. **Mecânica de Tear-Off e Dock-Back:**
   * Menu de contexto e ícone pop-out na aba: *"Mover para Nova Janela"*.
   * Botão na janela secundária: *"Reacoplar à Janela Principal"*.
