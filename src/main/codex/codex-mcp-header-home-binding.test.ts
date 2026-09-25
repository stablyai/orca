import { describe, expect, it } from 'vitest'
import { bindCodexMcpHeaderHelperHome } from './codex-mcp-header-home-binding'
import { parseTomlSingleLineStringValue } from './config-toml-line-scan'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'

const source = '/Users/example/.codex'
function config(command: string, table = '[mcp_servers.example]'): string {
  return `${table}\nhttp_headers_helper = ${JSON.stringify(command)} # keep comment\n`
}
function commandFrom(configText: string): string | undefined {
  const line = configText.split('\n')[1] ?? ''
  return parseTomlSingleLineStringValue(line, line.indexOf('=') + 1)?.value
}

describe('bindCodexMcpHeaderHelperHome', () => {
  it('preserves a native-valid default home and binds two distinct managed homes', () => {
    const input = config(`python helper.py --home '${source}'`)
    expect(bindCodexMcpHeaderHelperHome(input, source, source)).toBe(input)
    for (const home of ['/accounts/alice/home', '/accounts/bob/home']) {
      const output = bindCodexMcpHeaderHelperHome(input, source, home)
      expect(commandFrom(output)).toBe(`python helper.py --home '${home}'`)
      expect(output).toContain('# keep comment')
      expect(output).not.toContain(source)
    }
    expect(input).toContain(source)
  })
  it.each([source, `'${source}'`, `"${source}"`])('recognizes literal argument %s', (arg) => {
    expect(
      commandFrom(bindCodexMcpHeaderHelperHome(config(`helper --home ${arg}`), source, '/a'))
    ).toBe("helper --home '/a'")
  })
  it.each(['[mcp_servers."quoted.name"]', "[mcp_servers.'quoted.name']"])(
    'recognizes an exact server table %s',
    (table) => {
      expect(
        commandFrom(bindCodexMcpHeaderHelperHome(config(`helper '${source}'`, table), source, '/a'))
      ).toBe("helper '/a'")
    }
  )
  it.each(['/home/a b', "/home/a'b", '/home/$(untrusted)`text`$HOME'])(
    'quotes a managed home as data: %s',
    (home) => {
      expect(
        commandFrom(bindCodexMcpHeaderHelperHome(config(`helper '${source}'`), source, home))
      ).toBe(`helper ${quotePosixShell(home)}`)
    }
  )
  it('recognizes a safely quoted canonical home containing an apostrophe and spaces', () => {
    const home = "/Users/a'b c/.codex"
    expect(
      commandFrom(
        bindCodexMcpHeaderHelperHome(
          config(`helper --home ${quotePosixShell(home)}`),
          home,
          '/managed'
        )
      )
    ).toBe("helper --home '/managed'")
  })
  it('binds a WSL home using execution host paths', () => {
    const output = bindCodexMcpHeaderHelperHome(
      config("helper '/home/alice/.codex'"),
      String.raw`\\wsl.localhost\Ubuntu\home\alice\.codex`,
      String.raw`\\wsl.localhost\Ubuntu\home\alice\managed`
    )
    expect(commandFrom(output)).toBe("helper '/home/alice/managed'")
  })
  it('quotes a native Windows home without POSIX quoting', () => {
    const sourceHome = String.raw`C:\Users\Alice\.codex`
    const output = bindCodexMcpHeaderHelperHome(
      config(`helper "${sourceHome}"`),
      sourceHome,
      String.raw`C:\Users\Account Name\home`
    )
    expect(commandFrom(output)).toBe(String.raw`helper "C:\Users\Account Name\home"`)
  })
  it.each(['relative/home', '', '/home/line\nbreak', '/home/null\u0000byte'])(
    'rejects an invalid destination without echoing it: %s',
    (home) => {
      expect(() =>
        bindCodexMcpHeaderHelperHome(config(`helper '${source}'`), source, home)
      ).toThrow('MCP header helper requires an absolute runtime home')
    }
  )
  it.each([
    `helper --home=${source}`,
    `helper '${source}/child'`,
    `helper 'prefix ${source}'`,
    `helper "${source} suffix"`,
    `helper '$HOME'`,
    `helper # '${source}'`,
    `helper; next '${source}'`,
    `helper $(echo '${source}')`,
    `helper \\'${source}'`,
    `'${source}' --flag`,
    `   '${source}' --flag`
  ])('does not perform substring or shell-expression replacement: %s', (command) => {
    const input = config(command)
    expect(bindCodexMcpHeaderHelperHome(input, source, '/a')).toBe(input)
  })
  it.each([' ', '\t'])('preserves a home substring after escaped whitespace %j', (space) => {
    const input = config(`helper prefix\\${space}${source}`)
    expect(bindCodexMcpHeaderHelperHome(input, source, '/accounts/alice/home')).toBe(input)
  })
  it('recognizes a real argument boundary after an escaped backslash', () => {
    expect(
      commandFrom(bindCodexMcpHeaderHelperHome(config(`helper prefix\\\\ ${source}`), source, '/a'))
    ).toBe("helper prefix\\\\ '/a'")
  })
  it('does not rewrite other settings, subtables, comments or multiline data', () => {
    const input = [
      'model = "unchanged"',
      `# ${source}`,
      '[mcp_servers.example.env]',
      `http_headers_helper = "helper ${source}"`,
      '[other.example]',
      `http_headers_helper = "helper ${source}"`,
      'text = """',
      '[mcp_servers.fake]',
      `http_headers_helper = "helper ${source}"`,
      '"""',
      '[mcp_servers.example]',
      `url = "https://example.test${source}"`,
      ''
    ].join('\n')
    expect(bindCodexMcpHeaderHelperHome(input, source, '/a')).toBe(input)
  })
  it('does not rebind a helper that already names another home', () => {
    const once = bindCodexMcpHeaderHelperHome(config(`helper '${source}'`), source, '/a')
    expect(bindCodexMcpHeaderHelperHome(once, source, '/b')).toBe(once)
  })
  it('uses the existing TOML parser for quoted keys and spaced table segments', () => {
    const input = `[ "mcp_servers" . "custom.server" ]\n"http_headers_helper" = "helper '${source}'"\n`
    expect(commandFrom(bindCodexMcpHeaderHelperHome(input, source, '/managed'))).toBe(
      "helper '/managed'"
    )
  })
})
