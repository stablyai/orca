# Spec: Multi-Window & Tab Tear-Off

## Requisitos Funcionais

### REQ-MW-01: Flag Experimental de Múltiplas Janelas
* **Descrição:** A funcionalidade de múltiplas janelas DEVE vir protegida por uma configuração padrão desativada (`experimentalMultiWindow: false`), sem qualquer alteração de comportamento para os usuários padrão do Orca.
* **Critério de Aceite:** Quando desativada, `File > New Window` não aparece no menu e qualquer tentativa de abrir nova janela é tratada pelo singleton lock existente.

### REQ-MW-02: Registro de Janelas Principais (`MainWindowRegistry`)
* **Descrição:** O processo principal DEVE registrar todas as instâncias de `BrowserWindow` principais e broadcastar mudanças de UI (`ui:stateChanged`) para todas as janelas ativas.
* **Critério de Aceite:** Abrir uma janela secundária e alterar configurações ou temas deve refletir instantaneamente em ambas as telas sem necessidade de recarregar.

### REQ-MW-03: Comando `File > New Window`
* **Descrição:** Quando `experimentalMultiWindow: true`, o menu nativo da aplicação DEVE disponibilizar `File > New Window` com o atalho `Mod+Shift+N` (Command+Shift+N no macOS / Ctrl+Shift+N no Windows/Linux).
* **Critério de Aceite:** O comando cria uma janela independente no mesmo processo, com dimensões cascateadas, permitindo selecionar e navegar por qualquer worktree disponível.

### REQ-MW-04: Roteamento de Posse de PTY (`pty-owner-routing`)
* **Descrição:** O fluxo de entrada (`stdin`), saída (`stdout`) e redimensionamento (`pty:resize`) de cada terminal PTY DEVE ser roteado exclusivamente para a janela que hospeda a visualização do workspace correspondente.
* **Critério de Aceite:** Terminais com colunas diferentes em monitores distintos não sofrem interferência mútua de quebra de linha ou concorrência de buffer.

### REQ-MW-05: Composite Graph no Runtime
* **Descrição:** O `OrcaRuntimeService` DEVE aceitar sincronizações de grafo de múltiplas janelas, compondo um estado unificado exposto para a CLI e Mobile.
* **Critério de Aceite:** Comandos CLI como `orca worktree ps` e conexões do Orca Mobile devem listar todos os terminais e agentes em execução, independentemente de estarem na janela 1 ou na janela 2.

### REQ-MW-06: Ação de Menu de Contexto para Destaque de Abas
* **Descrição:** Clicar com botão direito em uma aba de workspace/chat/terminal DEVE exibir a opção *"Mover para Nova Janela"*.
* **Critério de Aceite:** Ao clicar na opção, a aba é desanexada da janela atual e abre em uma nova janela sem encerrar a sessão do agente nem perder o histórico do chat.

### REQ-MW-07: Proteção de Persistência de Sessão
* **Descrição:** Janelas secundárias NÃO DEVEM sobrescrever o arquivo de sessão principal com listas vazias de abas ou workspaces.
* **Critério de Aceite:** Fechar e reabrir o Orca preserva os workspaces da janela principal sem regressão.
