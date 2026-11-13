# Spec: Workspace Popout Window (Homologado em 4 Passes)

## Requisitos Funcionais & Critérios de Aceite

### REQ-WPO-01: Flag de Segurança Experimental
* **Descrição:** A funcionalidade DEVE vir condicionada à configuração `experimentalWorkspacePopout` (padrão `false`), mantendo o comportamento estável para os usuários normais.
* **Critério de Aceite:** Quando desativada, os botões e opções de popout permanecem ocultos e nenhuma janela secundária é instanciada.

### REQ-WPO-02: Janela Satélite Leve no Monitor Secundário
* **Descrição:** O sistema DEVE instanciar uma `BrowserWindow` leve dedicada (`workspace-popout-window.ts`) com dimensões salvas e validadas por `rectHasVisibleAreaOnAnyDisplay`.
* **Critério de Aceite:** A janela abre no monitor onde foi posicionada anteriormente e consome menos de 80MB de RAM.

### REQ-WPO-03: Zero Kill de Processos de Agentes
* **Descrição:** Abrir ou fechar a janela popout NÃO DEVE interromper, reiniciar ou matar os processos dos agentes (Claude Code, Codex, Antigravity) nem seus PTYs.
* **Critério de Aceite:** O PID do processo do agente no sistema operacional permanece inalterado durante todo o ciclo de vida de destaque e reacoplamento.

### REQ-WPO-04: Streaming de Terminal Interativo e Teclas de Controle
* **Descrição:** O terminal na janela popout DEVE suportar streaming contínuo sem deadlock de buffer e captura total de teclas interativas.
* **Critério de Aceite:**
  * Comandos interativos (`Ctrl+C`, `Ctrl+D`, setas, Vim, Htop e prompts `y/n`) respondem imediatamente.
  * Atalhos do macOS (`Cmd+C`, `Cmd+V`, `Cmd+A`) operam com segurança via bracketed paste mode.

### REQ-WPO-05: Integridade do Runtime Graph (CLI e Mobile)
* **Descrição:** A Janela 1 DEVE permanecer como autoridade única do grafo no `OrcaRuntimeService`.
* **Critério de Aceite:** `orca worktree ps` e o aplicativo Orca Mobile continuam listando e interagindo com todos os agentes, independentemente de estarem exibidos na tela principal ou na janela secundária.

### REQ-WPO-06: Blindagem Contra Desconexão de Cabos de Vídeo
* **Descrição:** Desconectar o monitor externo em tempo de execução DEVE reposicionar a janela popout para o monitor primário.
* **Critério de Aceite:** A janela nunca permanece em coordenadas inacessíveis fora da tela ativa.

### REQ-WPO-07: Reacoplamento Suave (Dock-Back)
* **Descrição:** O desenvolvedor DEVE poder reacoplar a janela com 1 clique ou via atalho de teclado (`Cmd+W` / botão de retorno).
* **Critério de Aceite:** A aba reaparece na janela principal, o foco é transferido e o `FitAddon` é reativado sem duplicação de listeners.
