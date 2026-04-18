import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
    main: {
        build: {
            // Why: daemon-entry.js is asar-unpacked so child_process.fork() can
            // execute it from disk. Node's module resolution from the unpacked
            // directory cannot reach into app.asar, so pure-JS dependencies used
            // by the daemon must be bundled rather than externalized.
            externalizeDeps: {
                exclude: ['@xterm/headless', '@xterm/addon-serialize']
            },
            rollupOptions: {
                input: {
                    index: resolve('src/main/index.ts'),
                    'daemon-entry': resolve('src/main/daemon/daemon-entry.ts')
                }
            }
        },
        // Why: @xterm/headless declares "exports": null in package.json, which
        // prevents Vite's default resolver from finding the CJS entry. Point
        // directly at the published main file so the bundler can inline it.
        resolve: {
            alias: {
                '@xterm/headless': resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.js'),
                '@xterm/addon-serialize': resolve('node_modules/@xterm/addon-serialize/lib/addon-serialize.js')
            }
        }
    },
    preload: {
        build: {
            externalizeDeps: {
                exclude: ['@electron-toolkit/preload']
            }
        }
    },
    renderer: {
        resolve: {
            alias: {
                '@renderer': resolve('src/renderer/src'),
                '@': resolve('src/renderer/src')
            }
        },
        plugins: [react(), tailwindcss()],
        worker: {
            format: 'es'
        }
    }
});
