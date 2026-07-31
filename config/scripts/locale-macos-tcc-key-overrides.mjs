export const MACOS_TCC_KEY_OVERRIDES = {
  'auto.hooks.useMacosTccPromptNotice.description': {
    es: 'macOS atribuye a Orca el acceso a archivos realizado por tus agentes y herramientas de terminal. Conceder acceso total al disco reduce estos avisos.',
    ja: 'エージェントやターミナルツールがファイルにアクセスすると、macOS はそのアクセス元を Orca として扱います。フルディスクアクセスを許可すると、これらの確認を減らせます。',
    ko: '에이전트와 터미널 도구의 파일 접근은 macOS에서 Orca의 접근으로 표시됩니다. 전체 디스크 접근 권한을 허용하면 이러한 요청을 줄일 수 있습니다.',
    zh: 'macOS 会将代理和终端工具的文件访问归因于 Orca。授予“完全磁盘访问权限”可减少此类提示。'
  },
  'auto.components.settings.DeveloperPermissionsPane.7ca17b62c8': {
    es: 'Cuando los agentes que ejecuta Orca leen datos de otras apps, macOS muestra el nombre de Orca porque es el proceso responsable de los comandos de terminal. Concede este permiso a Orca y Orca Helper para reducir esos avisos. Después, cierra Orca, finaliza cualquier proceso de Orca Helper que siga en ejecución y vuelve a abrir Orca.',
    ja: 'Orca が実行するエージェントがほかのアプリのデータを読み取ると、ターミナルコマンドの実行元プロセスである Orca の名前が macOS に表示されます。これらの確認を減らすには、Orca と Orca Helper にこの権限を許可してください。その後、Orca を終了し、残っている Orca Helper プロセスもすべて終了してから、Orca を再度開いてください。',
    ko: 'Orca가 실행하는 에이전트가 다른 앱의 데이터를 읽으면, macOS는 터미널 명령을 실행하는 프로세스인 Orca를 표시합니다. 이러한 요청을 줄이려면 Orca와 Orca Helper에 이 권한을 허용하세요. 그런 다음 Orca를 종료하고, 남아 있는 Orca Helper 프로세스도 모두 종료한 후 Orca를 다시 여세요.',
    zh: '当 Orca 运行的代理读取其他应用的数据时，macOS 会显示 Orca，因为 Orca 是执行终端命令的进程。请为 Orca 和 Orca Helper 授予此权限，以减少此类提示。然后退出 Orca，结束所有仍在运行的 Orca Helper 进程，再重新打开 Orca。'
  },
  'auto.components.settings.DeveloperPermissionsPane.c566bca278': {
    ko: '전체 디스크 접근 권한',
    zh: '完全磁盘访问权限'
  }
}
