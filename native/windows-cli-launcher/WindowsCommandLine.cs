using System;
using System.Text;

internal static class WindowsCommandLine
{
    // Why: Windows argv quoting requires backslash-doubling before embedded quotes; extracted
    // from OrcaCliLauncher.cs so both OrcaCliLauncher and OrcaTmuxShim share the same algorithm.
    internal static string Quote(string value)
    {
        bool requiresQuotes = value.Length == 0;
        for (int index = 0; index < value.Length && !requiresQuotes; index += 1)
        {
            requiresQuotes = value[index] == '"' || Char.IsWhiteSpace(value[index]);
        }
        if (!requiresQuotes)
        {
            return value;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashCount * 2 + 1);
                quoted.Append('"');
            }
            else
            {
                quoted.Append('\\', backslashCount);
                quoted.Append(character);
            }
            backslashCount = 0;
        }

        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    // Why: cmd.exe does not honour CRT's \" escape, so a quote inside a Quote()d argument closes
    // cmd's quoted region and exposes the rest as operators (BatBadBut / CVE-2024-24576). Doubling
    // the quote leaves cmd inside a quoted region while CommandLineToArgvW still reads one literal
    // quote, so the batch target's %* forwards the original argv. Always quotes: an unquoted & or |
    // is an operator to cmd even when the value has no whitespace.
    internal static string QuoteForCmd(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
                continue;
            }

            if (character == '"')
            {
                quoted.Append('\\', backslashCount * 2);
                quoted.Append("\"\"");
            }
            else
            {
                quoted.Append('\\', backslashCount);
                quoted.Append(character);
            }
            backslashCount = 0;
        }

        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    // Why: both entry-points need to prepend a subcommand argument before the forwarded argv.
    internal static string Join(string first, string[] rest)
    {
        return Join(first, rest, false);
    }

    internal static string Join(string first, string[] rest, bool forCmd)
    {
        StringBuilder commandLine = new StringBuilder(forCmd ? QuoteForCmd(first) : Quote(first));
        foreach (string arg in rest)
        {
            commandLine.Append(' ');
            commandLine.Append(forCmd ? QuoteForCmd(arg) : Quote(arg));
        }
        return commandLine.ToString();
    }
}
