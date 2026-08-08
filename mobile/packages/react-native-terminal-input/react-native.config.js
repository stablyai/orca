module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.orca.terminalinput.TerminalInputPackage;',
        packageInstance: 'new TerminalInputPackage()'
      },
      ios: null
    }
  }
}
