# Proposal: Suporte Nativo a Múltiplas Janelas e Destaque de Abas (Multi-Window & Tab Tear-Off)

## Contexto e Motivação

O **Orca** ([stablyai/orca](https://github.com/stablyai/orca)) consolidou-se como o ADE (Agentic Development Environment) de referência para orquestração paralela de agentes de código (Claude Code, Codex, Antigravity) isolados por Git worktrees.

No entanto, uma das limitações arquiteturais mais apontadas pela comunidade é a imposição de uma **janela desktop única** com `singleInstanceLock` rígido:
* **Issue #6074** (*[Feature]: Multiple windows*): Aberta há 4 meses com dezenas de reações e comentários diários de desenvolvedores exigindo suporte a múltiplos monitores e múltiplos desktops (Spaces/Virtual Desktops no macOS/Linux/Windows).
* **Issue #22167** (*Tear out floating workspaces into independent windows*): Necessidade de desanexar terminais e workspaces flutuantes para que prévias e diffs em tela cheia não ocultem o acompanhamento dos agentes.
* **Issue #28955** (*Move a terminal tab to its own window*): Permitir right-click em uma aba de terminal/chat e destacá-la para outra tela.
* **PR #5329** (*Add experimental multi-window support* por Brennan Benson): Tentativa oficial dos maintainers de viabilizar múltiplas janelas via flag experimental, mas que acabou estagnada com mais de 12.500 linhas de diff, conflitos massivos com a `main` e instabilidade sob carga de 25 PTYs concorrentes.
* **Protótipo Comunitário de Robert Crivat** ([Robert-Crivat/orca](https://github.com/Robert-Crivat/orca)): Demonstrou que uma abordagem modular e cirúrgica (~359 linhas) com `MainWindowRegistry` e `pty-owner-routing` é viável, porém deixou lacunas críticas (o silenciamento do grafo na janela secundária deixa a CLI e o Orca Mobile cegos aos agentes secundários; ausência de persistência de sessão e ausência de destaque de abas).

## Problema

1. **Monitores Secundários Subutilizados:** Usuários com dois ou mais monitores precisam escolher entre alternar workspaces na mesma janela ou recorrer ao navegador via `orca pair` (web client), perdendo a ergonomia nativa do desktop.
2. **Arquitetura Acoplada a uma Janela Única:**
   - O processo principal mantém um único `trustedUIRendererWebContentsId` (`src/main/ipc/ui.ts`).
   - O `OrcaRuntimeService` impõe uma única autoridade de grafo (`authoritativeWindowId`), rejeitando qualquer segunda janela com a exceção `Runtime graph publisher does not match the pending desktop promotion`.
   - A camada de streaming de PTY (`src/main/ipc/pty/`) não possuía particionamento de redimensionamento (`pty:resize`) nem de fluxo (`stdin`/`stdout`) por janela visualizadora, causando concorrência destrutiva entre resoluções de tela diferentes.
   - A persistência de sessão no frontend (`useAppSessionPersistence.ts`) grava de forma não escopada em `session.json`, fazendo com que uma janela secundária recém-aberta possa sobrescrever e apagar o layout da janela primária.

## Objetivos da Spec

1. **Permitir Múltiplas Janelas Nativas:** Suportar `File > New Window` (`Mod+Shift+N`) no macOS, Windows e Linux compartilhando o mesmo perfil de dados e runtime ativo sem corrupção de banco.
2. **Permitir Destaque de Abas (Tab Tear-Off):** Adicionar no menu de contexto das abas de workspace/chat/terminal a opção *"Mover para Nova Janela"* / *"Destacar Aba"*, desacoplando a visualização sem derrubar o processo de agente nem o PTY subjacente.
3. **Composite Window Graph no Runtime:** Substituir a autoridade de janela única no `OrcaRuntimeService` por um modelo de grafo composto (`Map<windowId, WindowGraph>`), garantindo que **a CLI do Orca, o Orca Mobile e as Skills continuem enxergando 100% dos agentes**, independentemente de em qual janela física eles estejam abertos.
4. **Isolamento de PTY e Persistência Segura:** Garantir que redimensionamentos de tela (ex: laptop 80 colunas vs monitor 4K 160 colunas) sejam estritamente roteados pela janela dona, e que o arquivo de sessão guarde o estado particionado por janela.
5. **Estratégia de PRs Upstream (Small PRs Series):** Em vez de submeter um PR monolítico de 12.000 linhas, estruturar a entrega em 3 waves modulares, default-off (`experimentalMultiWindow`), prontas para revisão e merge pelo time da Stably AI.
