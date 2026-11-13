# Spec: Multi-Window & Tab Tear-Off (Anchor-Satellite Model)

## Requisitos Funcionais & Critérios de Aceite

### REQ-MW-01: Flag Experimental de Segurança (`experimentalMultiWindow`)
* **Descrição:** A funcionalidade DEVE vir desativada por padrão em `experimentalMultiWindow: false`.
* **Critério de Aceite:** Quando desativada, a interface e os menus permanecem rigorosamente idênticos ao Orca estável. Nenhuma funcionalidade de multi-janela é disparada acidentalmente.

### REQ-MW-02: Modelo Anchor-Satellite no Registro de Janelas
* **Descrição:** O `MainWindowRegistry` DEVE distinguir a Janela Âncora (`anchor`) de Janelas Satélites (`satellite`).
* **Critério de Aceite:**
  * Fechar uma janela satélite não fecha o aplicativo nem derruba os agentes que nela estavam.
  * O app só encerra quando a última janela aberta for fechada pelo usuário.

### REQ-MW-03: Consumer Handover de Terminal sem Interrupção de Agentes
* **Descrição:** Mover uma aba com um agente em execução (Claude Code, Codex, Antigravity) de uma janela para outra DEVE transferir a visualização mantendo o PID do processo vivo.
* **Critério de Aceite:**
  * O processo do agente no sistema operacional não recebe `SIGTERM` nem reinicia.
  * O histórico do terminal (scrollback) é reconstituído na nova tela sem perda de linhas.

### REQ-MW-04: Exclusividade de Redimensionamento do PTY
* **Descrição:** Apenas a janela onde o terminal está visível e focado pode emitir `pty:resize`.
* **Critério de Aceite:** Janelas com larguras de tela diferentes não corrompem o wrapping de linhas do terminal xterm.

### REQ-MW-05: Grafo Composto e Visibilidade Universal (CLI & Mobile)
* **Descrição:** O `OrcaRuntimeService` DEVE manter o registro de workspaces de todas as janelas ativas e expor a união completa.
* **Critério de Aceite:**
  * `orca worktree ps` lista os agentes em execução tanto na Janela 1 quanto na Janela 2.
  * Conexões pareadas do Orca Mobile continuam recebendo status dos agentes da janela secundária.
  * Skills carregam e interagem normalmente com os agentes em ambas as janelas.

### REQ-MW-06: Ações de Tear-Off e Dock-Back na Interface
* **Descrição:** O usuário DEVE poder destacar abas e reacoplá-las de volta com 1 clique.
* **Critério de Aceite:**
  * Right-click na aba exibe a opção *"Mover para Nova Janela"*.
  * Na janela satélite, um botão *"Reacoplar à Janela Principal"* devolve a aba à janela âncora e fecha o satélite suavemente.

### REQ-MW-07: Proteção Antissobrescrita de Persistência no Disco
* **Descrição:** Janelas satélites NÃO DEVEM sobrescrever o arquivo `session.json` com estados parciais ou vazios.
* **Critério de Aceite:** Ao reiniciar o Orca, todos os workspaces abertos são preservados no disco sem regressão.
