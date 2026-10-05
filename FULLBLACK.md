# Orca Fullblack preview

This branch makes dark mode use black backgrounds, white primary text, subtle
dividers, and gray selected rows. Git status and syntax colors remain available.

## Try it from source

Use Node.js 24 and pnpm, plus the native build prerequisites for your platform.

```sh
git clone --branch theme/fullblack https://github.com/shadownrx/orca.git
cd orca
pnpm install --frozen-lockfile
pnpm dev
```

Select **Dark** in Orca's appearance settings. Quit another running Orca instance
before launching this preview.

This preview changes the existing dark theme. It does not add a separate theme
selector or automatically open a PR comment editor.

The colors and rendered interface were checked on macOS with Playwright against
a local copy of Orca 1.4.218. The source branch has not been packaged or verified
on Windows or Linux. No downloadable release is provided yet.
