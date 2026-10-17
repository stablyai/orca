def add(a, b):
    c = a + b  # LIVE-BREAKPOINT-TARGET
    print(f"LIVE-DEBUG-TARGET printed {c}")
    return c


if __name__ == "__main__":
    add(2, 3)
